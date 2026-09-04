/**
 * The production half of `drill-legal-hold.mjs`.
 *
 * The drill this replaces asserted nothing about the product. It INSERTed a row
 * into `hr_legal_holds` and then SELECTed the row back with its own hand-written
 * SQL, and called that "erasure blocked" — its own PASS string said so out loud
 * ("hold check query returns the active hold"). Its `holdCheck()` helper defined
 * `retentionBlocked` as `hrActive`, so `--self-test` verified a tautology. Nine
 * green assertions could not have gone red if every legal-hold guard in the
 * product had been deleted, because not one of them ran product code.
 *
 * Every assertion below calls a real service method that a real request reaches:
 *
 *   RetentionService.processRequest          the only erasure/anonymisation the
 *                                            product's own UI can reach
 *   RetentionService.sweepStrandedDeleteRequests   the retention sweep
 *   GdprSubjectErasureService.eraseSubject    the deep subject erasure
 *   GdprStoragePurgeService.buildManifest     the object-store purge manifest
 *   isUnderLegalHold / subjectsUnderLegalHold the shared predicate all of the
 *                                            above are supposed to agree with
 *   LegalHoldsService.create / release        hold placement and release
 *
 * A control phase runs FIRST, with no hold in place, and requires every one of
 * those paths to PERMIT the operation. Without it "blocked" would also be the
 * answer from a service that is simply broken, and the drill would pass on a
 * product that erases nothing for anyone.
 *
 * Everything runs inside one tenant transaction that is rolled back, so the drill
 * commits nothing — but unlike the old script the rollback is the only thing that
 * is simulated. The services are the real classes with a real database.
 *
 * Invoked by src/scripts/drill-legal-hold.mjs through ts-node; it emits one JSON
 * object on stdout and never decides the exit code itself.
 *
 *   node_modules/.bin/ts-node --transpile-only src/scripts/legal-hold-drill-probe.ts \
 *     --email=<subject> --org=<orgId>
 *   node_modules/.bin/ts-node --transpile-only src/scripts/legal-hold-drill-probe.ts --contract
 */
import { writeFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { CacheService } from "../common/cache/cache.service";
import { MediaCompressionService } from "../common/media/media-compression.service";
import { runInNewTenantTransaction } from "../common/tenant/run-in-tenant-transaction";
import { createTenantAwareDb, type DbWithClient } from "../common/tenant/tenant-db";
import * as schema from "../db/schema";
import { organizationMembers, users } from "../db/schema/common/auth";
import { organizationLegalHolds } from "../db/schema/common/organization-purge";
import { hrDataRequests } from "../db/schema/hr/governance";
import { GdprStoragePurgeService } from "../modules/gdpr/gdpr-storage-purge.service";
import { GdprSubjectErasureService } from "../modules/gdpr/gdpr-subject-erasure.service";
import { HrAuditService } from "../modules/hr/core/hr-audit.service";
import {
  isUnderLegalHold,
  subjectsUnderLegalHold,
} from "../modules/hr/governance/legal-holds/legal-hold-check.helper";
import { LegalHoldsService } from "../modules/hr/governance/legal-holds/legal-holds.service";
import { RetentionService } from "../modules/hr/governance/retention/retention.service";
import { SessionsService } from "../modules/sessions/sessions.service";
import { StorageService } from "../modules/storage/storage.service";
import {
  INERT_STORAGE_CONFIG,
  PRODUCTION_LEGAL_HOLD_PATHS,
  describeError,
  firstLine,
  inSavepoint,
  observeErasure,
  observeManifest,
  observeRefusal,
  requestStatus,
  type DrillCheck,
  type DrillReport,
} from "./legal-hold-drill-observations";

const ROLLBACK = "LEGAL_HOLD_DRILL_ROLLBACK";

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

/**
 * The report goes to a FILE, never to stdout.
 *
 * Loading the product loads its logger, and `RetentionService.sweepStrandedDeleteRequests`
 * writes a structured JSON line to stdout when it skips a held subject — exactly the
 * line this drill exists to provoke. A report on stdout was therefore unparseable in
 * precisely the run that proved the hold worked.
 */
function emit(report: DrillReport): void {
  const out = arg("out");
  if (!out) {
    process.stderr.write("legal-hold-drill-probe: --out=<path> is required\n");
    return;
  }
  writeFileSync(out, JSON.stringify(report, null, 2) + "\n", "utf8");
}

async function runDrill(email: string, orgId: string, url: string): Promise<DrillReport> {
  const client = postgres(url, { prepare: false, max: 4, onnotice: () => {} });
  const db: DbWithClient = createTenantAwareDb(
    Object.assign(drizzle(client, { schema }), { __client: client }),
  );

  const checks: DrillCheck[] = [];
  const record = (
    id: string,
    phase: DrillCheck["phase"],
    productionPath: string,
    expected: string,
    observed: string,
    ok: boolean,
  ): void => {
    checks.push({ id, phase, productionPath, expected, observed, ok });
  };

  try {
    const [subject] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (!subject) return { mode: "run", checks, error: `subject not found: ${email}` };

    const [membership] = await db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(
        and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, subject.id)),
      )
      .limit(1);
    if (!membership)
      return { mode: "run", checks, error: `subject ${email} is not a member of org ${orgId}` };

    const subjectUserId = subject.id;

    await runInNewTenantTransaction(db, orgId, async () => {
      const audit = new HrAuditService(db);
      const retention = new RetentionService(db, audit);
      const holds = new LegalHoldsService(db, audit);
      const storagePurge = new GdprStoragePurgeService(
        db,
        new StorageService(new MediaCompressionService(), INERT_STORAGE_CONFIG),
      );
      const erasure = new GdprSubjectErasureService(
        db,
        new CacheService(null),
        new SessionsService(db, null),
        storagePurge,
      );

      const actor = subjectUserId;

      /* ---------- control: with no hold, the product must PERMIT ---------- */

      const preHeld = await isUnderLegalHold(orgId, subjectUserId, db);
      record(
        "control.predicate",
        "control",
        "isUnderLegalHold",
        "false (no hold has been placed yet)",
        String(preHeld),
        preHeld === false,
      );
      if (preHeld) throw new Error(ROLLBACK);

      /*
       * `eraseSubject` and `buildManifest` return `blocked` from their hold gate
       * BEFORE they touch anything else, so "did not answer blocked" is the
       * observation that proves the gate is not stuck on. It is asserted that way
       * rather than as `blocked === false` because at head both calls die further
       * downstream, in storage-key-catalog.ts, on a defect this drill found and
       * which is reported verbatim in `observed` — see FINDING-STORAGE-KEY-ORG-ID.
       * Passing the gate is exactly what the assertion is about; the downstream
       * crash is a different criterion's defect and is printed, not hidden.
       */
      const controlErasure = await observeErasure(erasure, subjectUserId, orgId, actor);
      record(
        "control.eraseSubjectPassesHoldGate",
        "control",
        "GdprSubjectErasureService.eraseSubject",
        "does NOT answer blocked=true — the hold gate must let an unheld subject through",
        controlErasure.description,
        controlErasure.blocked === false,
      );

      const controlManifest = await observeManifest(storagePurge, subjectUserId, orgId);
      record(
        "control.buildManifestPassesHoldGate",
        "control",
        "GdprStoragePurgeService.buildManifest",
        "does NOT answer blocked=true",
        controlManifest.description,
        controlManifest.blocked === false,
      );

      /*
       * The end-to-end control, and the reason this drill cannot pass over a product
       * that refuses everyone: an unheld subject's delete request must actually run
       * to `completed` through the same method that must refuse under a hold.
       */
      const controlRequest = await retention.createRequest(orgId, actor, {
        subjectUserId,
        type: "delete",
        reason: "Legal-hold drill — control: an unheld deletion must complete",
      });
      await retention.approveRequest(orgId, controlRequest.id, actor);
      const controlRun = await inSavepoint(() =>
        retention.processRequest(orgId, controlRequest.id, actor),
      );
      const controlStatus = await requestStatus(db, orgId, controlRequest.id);
      const controlOk = !("error" in controlRun) && controlStatus === "completed";
      const controlOutcome =
        "error" in controlRun
          ? firstLine(describeError(controlRun.error))
          : `status=${String(controlStatus)}`;
      record(
        "control.processRequest",
        "control",
        "RetentionService.processRequest",
        'an unheld delete request runs and reaches "completed"',
        controlOutcome,
        controlOk,
      );

      /* ---------- held: an active HR hold must make the product REFUSE ---------- */

      const hold = await holds.create(orgId, actor, {
        subjectUserId,
        reason: `Legal-hold drill — production-path verification ${new Date().toISOString()}`,
      });

      const heldPredicate = await isUnderLegalHold(orgId, subjectUserId, db);
      record(
        "held.predicate",
        "held",
        "isUnderLegalHold",
        "true",
        String(heldPredicate),
        heldPredicate === true,
      );

      const heldSet = await subjectsUnderLegalHold(orgId, [subjectUserId], db);
      record(
        "held.predicateSet",
        "held",
        "subjectsUnderLegalHold",
        "the returned set contains the subject",
        `size=${heldSet.size} contains=${heldSet.has(subjectUserId)}`,
        heldSet.has(subjectUserId),
      );

      const heldErasure = await observeErasure(erasure, subjectUserId, orgId, actor);
      record(
        "held.eraseSubject",
        "held",
        "GdprSubjectErasureService.eraseSubject",
        `blocked=true, holdId=${hold.id}, nothing anonymised`,
        controlErasure.description === heldErasure.description
          ? `${heldErasure.description} (INDISTINGUISHABLE from the unheld control)`
          : heldErasure.description,
        heldErasure.blocked === true &&
          heldErasure.holdId === hold.id &&
          heldErasure.tablesAnonymised === 0,
      );

      const heldManifest = await observeManifest(storagePurge, subjectUserId, orgId);
      record(
        "held.buildManifest",
        "held",
        "GdprStoragePurgeService.buildManifest",
        "blocked=true and no object keys collected",
        heldManifest.description,
        heldManifest.blocked === true && heldManifest.keys === 0,
      );

      const heldRequest = await retention.createRequest(orgId, actor, {
        subjectUserId,
        type: "delete",
        reason: "Legal-hold drill — deletion must be refused while a hold is active",
      });
      await retention.approveRequest(orgId, heldRequest.id, actor);

      const heldRefusal = await observeRefusal(() =>
        retention.processRequest(orgId, heldRequest.id, actor),
      );
      record(
        "held.processRequest",
        "held",
        "RetentionService.processRequest",
        "ForbiddenException naming the legal hold",
        heldRefusal.description,
        heldRefusal.refused,
      );

      record(
        "held.requestNotCompleted",
        "held",
        "RetentionService.processRequest (persisted state)",
        'status stays "approved" — a refused request must not be recorded as completed',
        `status=${String(await requestStatus(db, orgId, heldRequest.id))}`,
        (await requestStatus(db, orgId, heldRequest.id)) === "approved",
      );

      /*
       * The stranded-request sweep only sees rows already in `processing`, a state
       * `processRequest` refuses to create under a hold. The row is moved there
       * directly because that is what a crash between the two status updates leaves
       * behind; what is asserted is the sweep's behaviour, not the row.
       */
      await db
        .update(hrDataRequests)
        .set({ status: "processing" })
        .where(and(eq(hrDataRequests.orgId, orgId), eq(hrDataRequests.id, heldRequest.id)));

      const heldSweep = await retention.sweepStrandedDeleteRequests(orgId);
      record(
        "held.sweep",
        "held",
        "RetentionService.sweepStrandedDeleteRequests",
        "skipped >= 1 and processed === 0",
        `processed=${heldSweep.processed} skipped=${heldSweep.skipped}`,
        heldSweep.processed === 0 && heldSweep.skipped >= 1,
      );

      /* ---------- the organisation-scoped hold must refuse on its own ---------- */

      await holds.release(orgId, hold.id, actor);
      const afterHrRelease = await isUnderLegalHold(orgId, subjectUserId, db);
      record(
        "released.hrHoldGone",
        "released",
        "LegalHoldsService.release + isUnderLegalHold",
        "false",
        String(afterHrRelease),
        afterHrRelease === false,
      );

      await db.insert(organizationLegalHolds).values({
        orgId,
        reason: "Legal-hold drill — organisation-scoped hold",
        placedBy: actor,
      });
      await db
        .update(hrDataRequests)
        .set({ status: "approved" })
        .where(and(eq(hrDataRequests.orgId, orgId), eq(hrDataRequests.id, heldRequest.id)));

      const orgRefusal = await observeRefusal(() =>
        retention.processRequest(orgId, heldRequest.id, actor),
      );
      record(
        "held.orgScopedProcessRequest",
        "held",
        "RetentionService.processRequest (organisation-scoped hold)",
        "ForbiddenException naming the legal hold",
        orgRefusal.description,
        orgRefusal.refused,
      );

      /* ---------- released: with every hold gone, the product must PERMIT again ---------- */

      await db
        .update(organizationLegalHolds)
        .set({ releasedAt: new Date(), releasedBy: actor })
        .where(eq(organizationLegalHolds.orgId, orgId));

      const releasedErasure = await observeErasure(erasure, subjectUserId, orgId, actor);
      record(
        "released.eraseSubjectPassesHoldGate",
        "released",
        "GdprSubjectErasureService.eraseSubject",
        "does NOT answer blocked=true once every hold is released",
        releasedErasure.description,
        releasedErasure.blocked === false,
      );

      const releasedRun = await inSavepoint(() =>
        retention.processRequest(orgId, heldRequest.id, actor),
      );
      const releasedStatus = await requestStatus(db, orgId, heldRequest.id);
      const releasedOk = !("error" in releasedRun) && releasedStatus === "completed";
      const releasedOutcome =
        "error" in releasedRun
          ? firstLine(describeError(releasedRun.error))
          : `status=${String(releasedStatus)}`;
      record(
        "released.processRequest",
        "released",
        "RetentionService.processRequest",
        'the same request that was refused now runs and reaches "completed"',
        releasedOutcome,
        releasedOk,
      );

      throw new Error(ROLLBACK);
    });

    return { mode: "run", subjectUserId, orgId, checks };
  } catch (err) {
    if (err instanceof Error && err.message === ROLLBACK)
      return { mode: "run", subjectUserId: undefined, orgId, checks };
    return { mode: "run", orgId, checks, error: describeError(err) };
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--contract")) {
    emit({
      mode: "contract",
      checks: PRODUCTION_LEGAL_HOLD_PATHS.map((path) => ({
        id: `contract.${path.symbol}`,
        phase: "control" as const,
        productionPath: path.symbol,
        expected: "callable on the production class",
        observed: path.present() ? "callable" : "MISSING",
        ok: path.present(),
      })),
    });
    return;
  }

  const email = arg("email")?.trim().toLowerCase();
  const orgId = arg("org")?.trim();
  const url = process.env.DATABASE_URL;

  if (!email || !orgId) {
    emit({ mode: "run", checks: [], error: "--email and --org are both required" });
    return;
  }
  if (!url) {
    emit({ mode: "run", checks: [], error: "DATABASE_URL is not set" });
    return;
  }

  emit(await runDrill(email, orgId, url));
}

void main().then(
  () => process.exit(0),
  (err: unknown) => {
    emit({ mode: "run", checks: [], error: describeError(err) });
    process.exit(0);
  },
);
