import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { and, count, eq, inArray, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  createTenantAwareDb,
  type DbWithClient,
} from "../common/tenant/tenant-db";
import { runInNewTenantTransaction } from "../common/tenant/run-in-tenant-transaction";
import * as schema from "../db/schema";
import { organizationMembers, users } from "../db/schema/common/auth";
import { helpdeskTickets } from "../db/schema/hr/attendance";
import { hrLegalHolds } from "../db/schema/hr/governance";
import { announcements } from "../db/schema/hr/announcements";
import { mailMessageMetadata } from "../db/schema/mail/mail-metadata";
import { CronAnnouncementsRetentionService } from "../modules/cron/cron-announcements-retention.service";
import { CronHelpdeskRetentionService } from "../modules/cron/cron-helpdesk-retention.service";
import { CronMailRetentionService } from "../modules/cron/cron-mail-retention.service";

const HELPDESK_BATCH_SIZE = 200;
const DRILL_ACCOUNT_ID = 88_888_888;

export interface DrillCheck {
  readonly id: string;
  readonly phase: string;
  readonly productionPath: string;
  readonly expected: string;
  readonly observed: string;
  readonly ok: boolean;
}
export interface DrillReport {
  readonly mode: "run" | "contract";
  readonly checks: readonly DrillCheck[];
  readonly error?: string;
}

/**
 * Anti-vacuity gate for the control phase. Named and exported so --contract can
 * verify its logic without a database: a "retained" verdict is meaningless when
 * the control sweep deleted nothing at all.
 */
export function assessControlDeletion(
  deleted: number,
  seeded: number,
): { ok: boolean; message: string } {
  if (seeded === 0)
    return { ok: false, message: "no rows seeded — drill misconfigured" };
  if (deleted === 0)
    return {
      ok: false,
      message: `control swept 0 of ${seeded} seeded rows — sweep may not be running`,
    };
  return { ok: true, message: `deleted ${deleted}/${seeded}` };
}

export const PRODUCTION_RETENTION_PATHS: readonly {
  symbol: string;
  present: () => boolean;
}[] = [
  {
    symbol: "CronHelpdeskRetentionService.sweep",
    present: () =>
      typeof CronHelpdeskRetentionService.prototype.sweep === "function",
  },
  {
    symbol: "CronMailRetentionService.sweep",
    present: () =>
      typeof CronMailRetentionService.prototype.sweep === "function",
  },
  {
    symbol: "CronAnnouncementsRetentionService.sweep",
    present: () =>
      typeof CronAnnouncementsRetentionService.prototype.sweep === "function",
  },
  {
    symbol: "assessControlDeletion (anti-vacuity)",
    present: () => typeof assessControlDeletion === "function",
  },
  {
    symbol: "assessControlDeletion rejects zero deletions",
    present: () => assessControlDeletion(0, 3).ok === false,
  },
];

function arg(name: string): string | undefined {
  return process.argv
    .slice(2)
    .find((a) => a.startsWith(`--${name}=`))
    ?.slice(`--${name}=`.length);
}
function emit(report: DrillReport): void {
  const out = arg("out");
  if (!out) {
    process.stderr.write("retention-drill-probe: --out=<path> required\n");
    return;
  }
  writeFileSync(out, JSON.stringify(report, null, 2) + "\n", "utf8");
}
function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}

async function countTickets(
  db: DbWithClient,
  orgId: string,
  userId: string,
): Promise<number> {
  return runInNewTenantTransaction(db, orgId, async () => {
    const [r] = await db
      .select({ c: count() })
      .from(helpdeskTickets)
      .where(
        and(
          eq(helpdeskTickets.orgId, orgId),
          eq(helpdeskTickets.userId, userId),
        ),
      );
    return Number(r?.c ?? 0);
  });
}
async function countMail(
  db: DbWithClient,
  orgId: string,
  membershipId: number,
): Promise<number> {
  return runInNewTenantTransaction(db, orgId, async () => {
    const [r] = await db
      .select({ c: count() })
      .from(mailMessageMetadata)
      .where(
        and(
          eq(mailMessageMetadata.orgId, orgId),
          eq(mailMessageMetadata.userMembershipId, membershipId),
        ),
      );
    return Number(r?.c ?? 0);
  });
}
async function countAnnouncements(
  db: DbWithClient,
  orgId: string,
  authorId: string,
): Promise<number> {
  return runInNewTenantTransaction(db, orgId, async () => {
    const [r] = await db
      .select({ c: count() })
      .from(announcements)
      .where(
        and(
          eq(announcements.orgId, orgId),
          eq(announcements.authorId, authorId),
        ),
      );
    return Number(r?.c ?? 0);
  });
}

async function cleanup(
  db: DbWithClient,
  orgIdA: string,
  orgIdB: string,
  userIds: string[],
  memberIds: number[],
  runId: string,
): Promise<void> {
  await runInNewTenantTransaction(db, orgIdA, async () => {
    if (memberIds.length > 0)
      await db
        .delete(mailMessageMetadata)
        .where(
          and(
            eq(mailMessageMetadata.orgId, orgIdA),
            inArray(mailMessageMetadata.userMembershipId, memberIds),
          ),
        );
    await db
      .delete(mailMessageMetadata)
      .where(
        and(
          eq(mailMessageMetadata.orgId, orgIdA),
          like(mailMessageMetadata.messageId, `%${runId}`),
        ),
      );
    await db
      .delete(helpdeskTickets)
      .where(
        and(
          eq(helpdeskTickets.orgId, orgIdA),
          inArray(helpdeskTickets.userId, userIds),
        ),
      );
    await db
      .delete(hrLegalHolds)
      .where(
        and(
          eq(hrLegalHolds.orgId, orgIdA),
          inArray(hrLegalHolds.subjectUserId, userIds),
        ),
      );
    await db
      .delete(announcements)
      .where(
        and(
          eq(announcements.orgId, orgIdA),
          inArray(announcements.authorId, userIds),
        ),
      );
    await db
      .delete(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, orgIdA),
          inArray(organizationMembers.userId, userIds),
        ),
      );
  });
  await runInNewTenantTransaction(db, orgIdB, async () => {
    await db
      .delete(helpdeskTickets)
      .where(
        and(
          eq(helpdeskTickets.orgId, orgIdB),
          inArray(helpdeskTickets.userId, userIds),
        ),
      );
  });
  await db.delete(users).where(inArray(users.id, userIds));
}

async function runDrill(
  orgIdA: string,
  orgIdB: string,
  url: string,
): Promise<DrillReport> {
  const client = postgres(url, { prepare: false, max: 4, onnotice: () => {} });
  const db: DbWithClient = createTenantAwareDb(
    Object.assign(drizzle(client, { schema }), { __client: client }),
  );
  const runId = randomUUID().replace(/-/g, "").slice(0, 12);
  const checks: DrillCheck[] = [];
  const rec = (
    id: string,
    phase: string,
    path: string,
    expected: string,
    observed: string,
    ok: boolean,
  ) => checks.push({ id, phase, productionPath: path, expected, observed, ok });

  const userHeldId = `dh-${runId}`;
  const userNormalId = `dn-${runId}`;
  let memberHeldId = 0;
  let memberNormalId = 0;

  const helpdeskSvc = new CronHelpdeskRetentionService(db);
  const mailSvc = new CronMailRetentionService(db);
  const announceSvc = new CronAnnouncementsRetentionService(db);

  try {
    await db.insert(users).values([
      { id: userHeldId, email: `drill-held-${runId}@drill.internal` },
      { id: userNormalId, email: `drill-normal-${runId}@drill.internal` },
    ]);

    ({ memberHeldId, memberNormalId } = await runInNewTenantTransaction(
      db,
      orgIdA,
      async () => {
        const [h] = await db
          .insert(organizationMembers)
          .values({ userId: userHeldId, orgId: orgIdA })
          .returning({ id: organizationMembers.id });
        const [n] = await db
          .insert(organizationMembers)
          .values({ userId: userNormalId, orgId: orgIdA })
          .returning({ id: organizationMembers.id });
        if (!h || !n)
          throw new Error("fixture membership insert returned no id");
        return { memberHeldId: h.id, memberNormalId: n.id };
      },
    ));

    /* ===== CONTROL — expired eligible data must be deleted (req 1) ===== */
    const HDEXP = daysAgo(800); // > 730-day helpdesk cutoff
    const MLEXP = daysAgo(400); // > 365-day mail cutoff
    const ANEXP = daysAgo(180); // > 90-day announcement grace
    const ANAGE = daysAgo(800); // > 730-day announcement max-age

    await runInNewTenantTransaction(db, orgIdA, async () => {
      await db.insert(helpdeskTickets).values([
        {
          orgId: orgIdA,
          userId: userNormalId,
          title: `ctrl-1-${runId}`,
          status: "RESOLVED",
          resolvedAt: HDEXP,
        },
        {
          orgId: orgIdA,
          userId: userNormalId,
          title: `ctrl-2-${runId}`,
          status: "CLOSED",
          resolvedAt: HDEXP,
        },
        {
          orgId: orgIdA,
          userId: userNormalId,
          title: `ctrl-3-${runId}`,
          status: "RESOLVED",
          resolvedAt: HDEXP,
        },
        {
          orgId: orgIdA,
          userId: userNormalId,
          title: `ctrl-recent-${runId}`,
          status: "TODO",
        },
      ]);
      await db.insert(mailMessageMetadata).values([
        {
          orgId: orgIdA,
          accountId: DRILL_ACCOUNT_ID,
          messageId: `cm1-${runId}`,
          userMembershipId: memberNormalId,
          syncedAt: MLEXP,
        },
        {
          orgId: orgIdA,
          accountId: DRILL_ACCOUNT_ID,
          messageId: `cm2-${runId}`,
          userMembershipId: memberNormalId,
          syncedAt: MLEXP,
        },
      ]);
      await db.insert(announcements).values([
        {
          orgId: orgIdA,
          title: `ctrl-ann-exp-${runId}`,
          content: "drill",
          authorId: userNormalId,
          expiresAt: ANEXP,
        },
        {
          orgId: orgIdA,
          title: `ctrl-ann-aged-${runId}`,
          content: "drill",
          authorId: userNormalId,
          createdAt: ANAGE,
        },
      ]);
    });

    const [ctHDBef, ctMLBef, ctANBef] = await Promise.all([
      countTickets(db, orgIdA, userNormalId),
      countMail(db, orgIdA, memberNormalId),
      countAnnouncements(db, orgIdA, userNormalId),
    ]);

    await helpdeskSvc.sweep();
    await mailSvc.sweep();
    await announceSvc.sweep();

    const [ctHDAft, ctMLAft, ctANAft] = await Promise.all([
      countTickets(db, orgIdA, userNormalId),
      countMail(db, orgIdA, memberNormalId),
      countAnnouncements(db, orgIdA, userNormalId),
    ]);

    const antiV = assessControlDeletion(ctHDBef - ctHDAft, ctHDBef);
    if (!antiV.ok)
      return { mode: "run", checks, error: `INCONCLUSIVE — ${antiV.message}` };

    rec(
      "control.helpdesk.deleted",
      "control",
      "CronHelpdeskRetentionService.sweep",
      "3 expired deleted, 1 recent (TODO) survived",
      `before=${ctHDBef} after=${ctHDAft} deleted=${ctHDBef - ctHDAft}`,
      ctHDBef - ctHDAft === 3 && ctHDAft === 1,
    );
    rec(
      "control.mail.deleted",
      "control",
      "CronMailRetentionService.sweep",
      "2 expired mail rows deleted",
      `before=${ctMLBef} after=${ctMLAft}`,
      ctMLBef - ctMLAft === 2 && ctMLAft === 0,
    );
    rec(
      "control.announcements.deleted",
      "control",
      "CronAnnouncementsRetentionService.sweep",
      "2 expired announcements deleted (1 by expires_at, 1 by created_at age)",
      `before=${ctANBef} after=${ctANAft}`,
      ctANBef - ctANAft === 2 && ctANAft === 0,
    );

    /* ===== HELD — legally-held subjects retained (req 2) ===== */
    await runInNewTenantTransaction(db, orgIdA, async () => {
      await db.insert(hrLegalHolds).values({
        orgId: orgIdA,
        subjectUserId: userHeldId,
        reason: `drill-${runId}`,
        placedBy: userNormalId,
      });
      await db.insert(helpdeskTickets).values([
        {
          orgId: orgIdA,
          userId: userHeldId,
          title: `held-h1-${runId}`,
          status: "RESOLVED",
          resolvedAt: HDEXP,
        },
        {
          orgId: orgIdA,
          userId: userHeldId,
          title: `held-h2-${runId}`,
          status: "RESOLVED",
          resolvedAt: HDEXP,
        },
        {
          orgId: orgIdA,
          userId: userNormalId,
          title: `held-n1-${runId}`,
          status: "RESOLVED",
          resolvedAt: HDEXP,
        },
      ]);
      await db.insert(mailMessageMetadata).values([
        {
          orgId: orgIdA,
          accountId: DRILL_ACCOUNT_ID,
          messageId: `hm-h-${runId}`,
          userMembershipId: memberHeldId,
          syncedAt: MLEXP,
        },
        {
          orgId: orgIdA,
          accountId: DRILL_ACCOUNT_ID,
          messageId: `hm-n-${runId}`,
          userMembershipId: memberNormalId,
          syncedAt: MLEXP,
        },
      ]);
      await db.insert(announcements).values([
        {
          orgId: orgIdA,
          title: `held-ah-${runId}`,
          content: "drill",
          authorId: userHeldId,
          expiresAt: ANEXP,
        },
        {
          orgId: orgIdA,
          title: `held-an-${runId}`,
          content: "drill",
          authorId: userNormalId,
          expiresAt: ANEXP,
        },
      ]);
    });

    const [hhDBef, hnDBef, hhMLBef, hnMLBef, hhANBef, hnANBef] =
      await Promise.all([
        countTickets(db, orgIdA, userHeldId),
        countTickets(db, orgIdA, userNormalId),
        countMail(db, orgIdA, memberHeldId),
        countMail(db, orgIdA, memberNormalId),
        countAnnouncements(db, orgIdA, userHeldId),
        countAnnouncements(db, orgIdA, userNormalId),
      ]);

    await helpdeskSvc.sweep();
    await mailSvc.sweep();
    await announceSvc.sweep();

    const [hhDAft, hnDAft, hhMLAft, hnMLAft, hhANAft, hnANAft] =
      await Promise.all([
        countTickets(db, orgIdA, userHeldId),
        countTickets(db, orgIdA, userNormalId),
        countMail(db, orgIdA, memberHeldId),
        countMail(db, orgIdA, memberNormalId),
        countAnnouncements(db, orgIdA, userHeldId),
        countAnnouncements(db, orgIdA, userNormalId),
      ]);

    rec(
      "held.helpdesk.protected",
      "held",
      "CronHelpdeskRetentionService.sweep",
      "held user's 2 expired tickets not deleted",
      `before=${hhDBef} after=${hhDAft}`,
      hhDAft === hhDBef && hhDBef > 0,
    );
    rec(
      "held.helpdesk.normal_deleted",
      "held",
      "CronHelpdeskRetentionService.sweep",
      "unheld user's 1 expired ticket deleted (1 recent survives)",
      `before=${hnDBef} after=${hnDAft}`,
      hnDAft < hnDBef && hnDAft > 0,
    );
    rec(
      "held.mail.protected",
      "held",
      "CronMailRetentionService.sweep",
      "held membership's expired mail not deleted",
      `before=${hhMLBef} after=${hhMLAft}`,
      hhMLAft === hhMLBef && hhMLBef > 0,
    );
    rec(
      "held.mail.normal_deleted",
      "held",
      "CronMailRetentionService.sweep",
      "unheld membership's expired mail deleted",
      `before=${hnMLBef} after=${hnMLAft}`,
      hnMLAft < hnMLBef,
    );
    rec(
      "held.announcements.protected",
      "held",
      "CronAnnouncementsRetentionService.sweep",
      "held author's expired announcement not deleted",
      `before=${hhANBef} after=${hhANAft}`,
      hhANAft === hhANBef && hhANBef > 0,
    );
    rec(
      "held.announcements.normal_deleted",
      "held",
      "CronAnnouncementsRetentionService.sweep",
      "unheld author's expired announcement deleted",
      `before=${hnANBef} after=${hnANAft}`,
      hnANAft < hnANBef,
    );

    /* ===== ISOLATION — holds are org-scoped; orgB not cross-contaminated (req 3) ===== */
    await runInNewTenantTransaction(db, orgIdB, async () => {
      await db.insert(helpdeskTickets).values([
        {
          orgId: orgIdB,
          userId: userHeldId,
          title: `iso-1-${runId}`,
          status: "RESOLVED",
          resolvedAt: HDEXP,
        },
        {
          orgId: orgIdB,
          userId: userHeldId,
          title: `iso-2-${runId}`,
          status: "RESOLVED",
          resolvedAt: HDEXP,
        },
      ]);
    });

    const [orgBSeed, orgAHBef] = await Promise.all([
      countTickets(db, orgIdB, userHeldId),
      countTickets(db, orgIdA, userHeldId),
    ]);
    await helpdeskSvc.sweep();
    const [orgBAft, orgAHAft] = await Promise.all([
      countTickets(db, orgIdB, userHeldId),
      countTickets(db, orgIdA, userHeldId),
    ]);

    rec(
      "isolated.helpdesk.orgb_deleted",
      "isolated",
      "CronHelpdeskRetentionService.sweep",
      "orgB tickets for userHeld deleted — orgA hold does not cross org boundary",
      `orgBSeeded=${orgBSeed} orgBAfter=${orgBAft}`,
      orgBAft < orgBSeed && orgBSeed > 0,
    );
    rec(
      "isolated.helpdesk.orga_protected",
      "isolated",
      "CronHelpdeskRetentionService.sweep",
      "orgA hold still protects userHeld after orgB sweep ran",
      `orgABefore=${orgAHBef} orgAAfter=${orgAHAft}`,
      orgAHAft === orgAHBef && orgAHAft > 0,
    );

    /* ===== IDEMPOTENCY — re-run is safe (req 4) ===== */
    const idempBef = await countTickets(db, orgIdA, userHeldId);
    await helpdeskSvc.sweep();
    const idempAft = await countTickets(db, orgIdA, userHeldId);
    rec(
      "idempotent.helpdesk",
      "idempotent",
      "CronHelpdeskRetentionService.sweep (second run)",
      "held rows unchanged — sweep safe to retry",
      `before=${idempBef} after=${idempAft}`,
      idempAft === idempBef && idempBef > 0,
    );

    /* ===== BATCH — cursor loops, no silent truncation (req 5) ===== */
    const batchCount = HELPDESK_BATCH_SIZE + 1;
    const batchRows = Array.from({ length: batchCount }, (_, i) => ({
      orgId: orgIdA,
      userId: userNormalId,
      title: `batch-${i}-${runId}`,
      status: "RESOLVED" as const,
      resolvedAt: HDEXP,
    }));
    await runInNewTenantTransaction(db, orgIdA, async () => {
      for (let i = 0; i < batchRows.length; i += 100)
        await db.insert(helpdeskTickets).values(batchRows.slice(i, i + 100));
    });
    const batchBef = await countTickets(db, orgIdA, userNormalId);
    const batchResult = await helpdeskSvc.sweep();
    const batchAft = await countTickets(db, orgIdA, userNormalId);
    const batchDel = batchBef - batchAft;

    rec(
      "batch.helpdesk.all_deleted",
      "batch",
      "CronHelpdeskRetentionService.sweep (BATCH_SIZE+1 rows)",
      `all ${batchCount} expired rows deleted; sweep loops across multiple batches`,
      `before=${batchBef} after=${batchAft} deleted=${batchDel}`,
      batchDel >= batchCount,
    );
    rec(
      "batch.helpdesk.not_truncated",
      "batch",
      "CronHelpdeskRetentionService.sweep (HelpdeskRetentionResult.truncated)",
      "truncated=false — cursor drained completely for fixture org",
      `truncated=${batchResult.truncated}`,
      !batchResult.truncated,
    );

    return { mode: "run", checks };
  } catch (err) {
    return {
      mode: "run",
      checks,
      error:
        err instanceof Error
          ? `${err.constructor.name}: ${err.message}`
          : String(err),
    };
  } finally {
    const memberIds = [memberHeldId, memberNormalId].filter((m) => m > 0);
    await cleanup(
      db,
      orgIdA,
      orgIdB,
      [userHeldId, userNormalId],
      memberIds,
      runId,
    ).catch((e: unknown) =>
      process.stderr.write(
        `[retention-drill-probe] cleanup: ${e instanceof Error ? e.message : String(e)}\n`,
      ),
    );
    await client.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--contract")) {
    emit({
      mode: "contract",
      checks: PRODUCTION_RETENTION_PATHS.map((p) => ({
        id: `contract.${p.symbol}`,
        phase: "control",
        productionPath: p.symbol,
        expected: "callable / correct",
        observed: p.present() ? "present and correct" : "MISSING or WRONG",
        ok: p.present(),
      })),
    });
    return;
  }

  const orgIdA = arg("org-a")?.trim();
  const orgIdB = arg("org-b")?.trim();
  const url = process.env.SCRATCH_DATABASE_URL;
  if (!orgIdA || !orgIdB) {
    emit({
      mode: "run",
      checks: [],
      error: "--org-a and --org-b are both required",
    });
    return;
  }
  if (!url) {
    emit({ mode: "run", checks: [], error: "SCRATCH_DATABASE_URL is not set" });
    return;
  }
  emit(await runDrill(orgIdA, orgIdB, url));
}

void main().then(
  () => process.exit(0),
  (err: unknown) => {
    emit({
      mode: "run",
      checks: [],
      error:
        err instanceof Error
          ? `${err.constructor.name}: ${err.message}`
          : String(err),
    });
    process.exit(0);
  },
);
