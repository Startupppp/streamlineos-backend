/**
 * The observation primitives `legal-hold-drill-probe.ts` asserts with, and the
 * list of production symbols it must reach.
 *
 * They live apart from the drill for one reason: every one of them exists to stop
 * the drill from grading its own homework. `PRODUCTION_LEGAL_HOLD_PATHS` names the
 * product methods by symbol so `--contract` fails when a rename detaches the drill
 * from them; `inSavepoint` keeps a downstream failure from aborting the drill's
 * transaction and being misreported as the legal-hold verdict; and each `observe*`
 * helper returns what actually happened as text, so a check that passes still
 * shows the operator the outcome it passed on.
 */
import { ForbiddenException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { getTenantContext, runWithTenantContext } from "../common/tenant/tenant-context";
import type { DbWithClient } from "../common/tenant/tenant-db";
import { hrDataRequests } from "../db/schema/hr/governance";
import { GdprStoragePurgeService } from "../modules/gdpr/gdpr-storage-purge.service";
import { GdprSubjectErasureService } from "../modules/gdpr/gdpr-subject-erasure.service";
import {
  isUnderLegalHold,
  subjectsUnderLegalHold,
} from "../modules/hr/governance/legal-holds/legal-hold-check.helper";
import { LegalHoldsService } from "../modules/hr/governance/legal-holds/legal-holds.service";
import { RetentionService } from "../modules/hr/governance/retention/retention.service";
import type { StorageConfig } from "../modules/storage/storage.service";

export interface DrillCheck {
  readonly id: string;
  /** "control" runs with no hold and must PERMIT; "held" must REFUSE; "released" must PERMIT again. */
  readonly phase: "control" | "held" | "released";
  /** The production symbol whose behaviour this check observed. Never the drill's own SQL. */
  readonly productionPath: string;
  readonly expected: string;
  readonly observed: string;
  readonly ok: boolean;
}

export interface DrillReport {
  readonly mode: "run" | "contract";
  readonly subjectUserId?: string;
  readonly orgId?: string;
  readonly checks: readonly DrillCheck[];
  readonly error?: string;
}

/**
 * The methods this drill exercises, as a contract `--contract` can assert without
 * a database. A rename that silently detached the drill from the product is the
 * failure this catches: the old script would have kept passing, because it never
 * referred to any of them.
 */
export const PRODUCTION_LEGAL_HOLD_PATHS: readonly {
  readonly symbol: string;
  readonly present: () => boolean;
}[] = [
  {
    symbol: "RetentionService.processRequest",
    present: () => typeof RetentionService.prototype.processRequest === "function",
  },
  {
    symbol: "RetentionService.sweepStrandedDeleteRequests",
    present: () => typeof RetentionService.prototype.sweepStrandedDeleteRequests === "function",
  },
  {
    symbol: "GdprSubjectErasureService.eraseSubject",
    present: () => typeof GdprSubjectErasureService.prototype.eraseSubject === "function",
  },
  {
    symbol: "GdprStoragePurgeService.buildManifest",
    present: () => typeof GdprStoragePurgeService.prototype.buildManifest === "function",
  },
  {
    symbol: "LegalHoldsService.create",
    present: () => typeof LegalHoldsService.prototype.create === "function",
  },
  {
    symbol: "LegalHoldsService.release",
    present: () => typeof LegalHoldsService.prototype.release === "function",
  },
  { symbol: "isUnderLegalHold", present: () => typeof isUnderLegalHold === "function" },
  { symbol: "subjectsUnderLegalHold", present: () => typeof subjectsUnderLegalHold === "function" },
];

/**
 * The object-store credentials are deliberately unusable. `buildManifest` is the
 * only StorageService-shaped path this drill reaches and it never leaves the
 * database, so a drill that could talk to a bucket would be a drill that could
 * delete from one.
 */
export const INERT_STORAGE_CONFIG: StorageConfig = {
  R2_REGION: "auto",
  R2_BUCKET_NAME: "legal-hold-drill-no-bucket",
  R2_ACCESS_KEY_ID: "drill-no-credential",
  R2_SECRET_ACCESS_KEY: "drill-no-credential",
  R2_ENDPOINT: "http://127.0.0.1:1",
  NEXT_PUBLIC_R2_PUBLIC_URL: "http://127.0.0.1:1",
};

export function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? text;
}

/**
 * Includes the driver's `cause`. A DrizzleQueryError's own message is the SQL text
 * with the reason buried under it, so the first line alone reads "Failed query:" and
 * says nothing — which is useless in the one place this drill reports a downstream
 * defect it does not own.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause: unknown = Reflect.get(err, "cause");
  const causeMessage = cause instanceof Error ? ` (${firstLine(cause.message)})` : "";
  return `${err.constructor.name}: ${firstLine(err.message)}${causeMessage}`;
}

export interface GateObservation {
  /** `true` only when the hold gate itself answered. Any other outcome is `false`. */
  readonly blocked: boolean;
  readonly holdId?: number;
  readonly tablesAnonymised: number;
  readonly keys: number;
  /** What actually happened, verbatim, including a downstream failure. */
  readonly description: string;
}

/**
 * Runs `fn` inside a SAVEPOINT so a statement error does not abort the drill's
 * outer transaction.
 *
 * Postgres aborts a whole transaction on the first failed statement, so an
 * observation that CATCHES a query error would otherwise leave every later step
 * failing with "current transaction is aborted" and the drill reporting the
 * wrong reason for its own collapse. The failure is still surfaced — it is
 * returned to the caller and printed — it just stops being contagious.
 */
export async function inSavepoint<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: unknown }> {
  const ctx = getTenantContext();
  if (!ctx) return { error: new Error("inSavepoint: no ambient tenant transaction") };
  try {
    const value = await ctx.tx.transaction((savepoint) =>
      runWithTenantContext({ ...ctx, tx: savepoint }, fn),
    );
    return { value };
  } catch (err) {
    return { error: err };
  }
}

export async function observeErasure(
  erasure: GdprSubjectErasureService,
  subjectUserId: string,
  orgId: string,
  actor: string,
): Promise<GateObservation> {
  const outcome = await inSavepoint(() =>
    erasure.eraseSubject(subjectUserId, orgId, actor, { dryRun: true }),
  );
  const result = outcome.value;
  if (!result)
    return {
      blocked: false,
      tablesAnonymised: 0,
      keys: 0,
      description: `passed the hold gate, then failed downstream — ${firstLine(describeError(outcome.error))}`,
    };
  return {
    blocked: result.blocked,
    holdId: result.holdId,
    tablesAnonymised: result.tablesAnonymised.length,
    keys: result.storage.manifestSize,
    description: `blocked=${result.blocked} holdId=${String(result.holdId)} tablesAnonymised=${result.tablesAnonymised.length}`,
  };
}

export async function observeManifest(
  storagePurge: GdprStoragePurgeService,
  subjectUserId: string,
  orgId: string,
): Promise<GateObservation> {
  const outcome = await inSavepoint(() => storagePurge.buildManifest(subjectUserId, [orgId]));
  const manifest = outcome.value;
  if (!manifest)
    return {
      blocked: false,
      tablesAnonymised: 0,
      keys: 0,
      description: `passed the hold gate, then failed downstream — ${firstLine(describeError(outcome.error))}`,
    };
  return {
    blocked: manifest.blocked,
    tablesAnonymised: 0,
    keys: manifest.keys.length,
    description: `blocked=${manifest.blocked} keys=${manifest.keys.length}`,
  };
}

export interface RefusalObservation {
  readonly refused: boolean;
  readonly description: string;
}

/** A refusal counts only when it is the legal-hold refusal, not any thrown error. */
export async function observeRefusal(call: () => Promise<unknown>): Promise<RefusalObservation> {
  const outcome = await inSavepoint(call);
  if (!("error" in outcome))
    return { refused: false, description: "resolved — the operation was NOT refused" };
  const described = describeError(outcome.error);
  return {
    refused: outcome.error instanceof ForbiddenException && /legal hold/i.test(described),
    description: firstLine(described),
  };
}

export async function requestStatus(
  db: DbWithClient,
  orgId: string,
  requestId: number,
): Promise<string | undefined> {
  const [row] = await db
    .select({ status: hrDataRequests.status })
    .from(hrDataRequests)
    .where(and(eq(hrDataRequests.orgId, orgId), eq(hrDataRequests.id, requestId)))
    .limit(1);
  return row?.status;
}
