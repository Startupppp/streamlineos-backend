import postgres from "postgres";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, count, eq, inArray, like } from "drizzle-orm";
import {
  type DbWithClient,
  createTenantAwareDb,
} from "../common/tenant/tenant-db";
import * as schema from "../db/schema";
import { hrLegalHolds } from "../db/schema/hr/governance";
import { helpdeskTickets } from "../db/schema/hr/attendance";
import { announcements } from "../db/schema/hr/announcements";
import { organizationMembers, users } from "../db/schema/common/auth";
import { mailMessageMetadata } from "../db/schema/mail/mail-metadata";
import { CronMailRetentionService } from "../modules/cron/cron-mail-retention.service";
import { runInNewTenantTransaction } from "../common/tenant/run-in-tenant-transaction";
import { CronHelpdeskRetentionService } from "../modules/cron/cron-helpdesk-retention.service";
import { CronAnnouncementsRetentionService } from "../modules/cron/cron-announcements-retention.service";

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
 * Anti-vacuity gate for the control phase.
 *
 * A "retained" verdict is meaningless when the sweep deleted nothing at all —
 * it could mean the product works, or it could mean the sweep is broken. The
 * control phase must delete at least one row or the drill cannot proceed.
 *
 * This function is named and exported so --contract can assert it exists and
 * verify its logic without a database.
 */
export function assessControlDeletion(
  deleted: number,
  seeded: number,
): { ok: boolean; message: string } {
  if (seeded === 0)
    return {
      ok: false,
      message: "no rows were seeded — drill is misconfigured",
    };
  if (deleted === 0)
    return {
      ok: false,
      message: `control swept 0 rows despite ${seeded} seeded — the sweep may not be running`,
    };
  return { ok: true, message: `deleted ${deleted} of ${seeded} eligible rows` };
}

/**
 * The product symbols this drill exercises. --contract verifies these without a
 * database: a rename that silently detaches the drill from the product fails here
 * rather than silently passing on stale counts.
 */
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
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .find((a) => a.startsWith(prefix))
    ?.slice(prefix.length);
}

function emit(report: DrillReport): void {
  const out = arg("out");
  if (!out) {
    process.stderr.write("retention-drill-probe: --out=<path> is required\n");
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
    const [row] = await db
      .select({ c: count() })
      .from(helpdeskTickets)
      .where(
        and(
          eq(helpdeskTickets.orgId, orgId),
          eq(helpdeskTickets.userId, userId),
        ),
      );
    return Number(row?.c ?? 0);
  });
}

async function countMail(
  db: DbWithClient,
  orgId: string,
  membershipId: number,
): Promise<number> {
  return runInNewTenantTransaction(db, orgId, async () => {
    const [row] = await db
      .select({ c: count() })
      .from(mailMessageMetadata)
      .where(
        and(
          eq(mailMessageMetadata.orgId, orgId),
          eq(mailMessageMetadata.userMembershipId, membershipId),
        ),
      );
    return Number(row?.c ?? 0);
  });
}

async function countAnnouncements(
  db: DbWithClient,
  orgId: string,
  authorId: string,
): Promise<number> {
  return runInNewTenantTransaction(db, orgId, async () => {
    const [row] = await db
      .select({ c: count() })
      .from(announcements)
      .where(
        and(
          eq(announcements.orgId, orgId),
          eq(announcements.authorId, authorId),
        ),
      );
    return Number(row?.c ?? 0);
  });
}

async function cleanup(
  db: DbWithClient,
  orgIdA: string,
  orgIdB: string,
  userHeldId: string,
  userNormalId: string,
  memberHeldId: number,
  memberNormalId: number,
  runId: string,
): Promise<void> {
  const userIds = [userHeldId, userNormalId];
  const memberIds = [memberHeldId, memberNormalId].filter((m) => m > 0);

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
  const record = (
    id: string,
    phase: string,
    productionPath: string,
    expected: string,
    observed: string,
    ok: boolean,
  ): void => {
    checks.push({ id, phase, productionPath, expected, observed, ok });
  };

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

    /* ===== CONTROL PHASE — expired eligible data must be deleted (req 1) ===== */

    const HELPDESK_EXP = daysAgo(800); // 800 > 730-day cutoff
    const MAIL_EXP = daysAgo(400); // 400 > 365-day cutoff
    const ANN_EXP = daysAgo(180); // 180 > 90-day grace period
    const ANN_AGE = daysAgo(800); // 800 > 730-day max-age cutoff

    await runInNewTenantTransaction(db, orgIdA, async () => {
      await db.insert(helpdeskTickets).values([
        {
          orgId: orgIdA,
          userId: userNormalId,
          title: `ctrl-1-${runId}`,
          status: "RESOLVED",
          resolvedAt: HELPDESK_EXP,
        },
        {
          orgId: orgIdA,
          userId: userNormalId,
          title: `ctrl-2-${runId}`,
          status: "CLOSED",
          resolvedAt: HELPDESK_EXP,
        },
        {
          orgId: orgIdA,
          userId: userNormalId,
          title: `ctrl-3-${runId}`,
          status: "RESOLVED",
          resolvedAt: HELPDESK_EXP,
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
          syncedAt: MAIL_EXP,
        },
        {
          orgId: orgIdA,
          accountId: DRILL_ACCOUNT_ID,
          messageId: `cm2-${runId}`,
          userMembershipId: memberNormalId,
          syncedAt: MAIL_EXP,
        },
      ]);
      await db.insert(announcements).values([
        {
          orgId: orgIdA,
          title: `ctrl-ann-exp-${runId}`,
          content: "drill",
          authorId: userNormalId,
          expiresAt: ANN_EXP,
        },
        {
          orgId: orgIdA,
          title: `ctrl-ann-aged-${runId}`,
          content: "drill",
          authorId: userNormalId,
          createdAt: ANN_AGE,
        },
      ]);
    });

    const ctrlTicketsBefore = await countTickets(db, orgIdA, userNormalId);
    const ctrlMailBefore = await countMail(db, orgIdA, memberNormalId);
    const ctrlAnnBefore = await countAnnouncements(db, orgIdA, userNormalId);

    await helpdeskSvc.sweep();
    await mailSvc.sweep();
    await announceSvc.sweep();

    const ctrlTicketsAfter = await countTickets(db, orgIdA, userNormalId);
    const ctrlMailAfter = await countMail(db, orgIdA, memberNormalId);
    const ctrlAnnAfter = await countAnnouncements(db, orgIdA, userNormalId);

    const antiV = assessControlDeletion(
      ctrlTicketsBefore - ctrlTicketsAfter,
      ctrlTicketsBefore,
    );
    if (!antiV.ok)
      return { mode: "run", checks, error: `INCONCLUSIVE — ${antiV.message}` };

    record(
      "control.helpdesk.deleted",
      "control",
      "CronHelpdeskRetentionService.sweep",
      "3 expired tickets deleted, 1 recent (TODO) survived",
      `before=${ctrlTicketsBefore} after=${ctrlTicketsAfter} deleted=${ctrlTicketsBefore - ctrlTicketsAfter}`,
      ctrlTicketsBefore - ctrlTicketsAfter === 3 && ctrlTicketsAfter === 1,
    );
    record(
      "control.mail.deleted",
      "control",
      "CronMailRetentionService.sweep",
      "2 expired mail rows deleted",
      `before=${ctrlMailBefore} after=${ctrlMailAfter}`,
      ctrlMailBefore - ctrlMailAfter === 2 && ctrlMailAfter === 0,
    );
    record(
      "control.announcements.deleted",
      "control",
      "CronAnnouncementsRetentionService.sweep",
      "2 expired announcements deleted (1 via expires_at, 1 via created_at age)",
      `before=${ctrlAnnBefore} after=${ctrlAnnAfter}`,
      ctrlAnnBefore - ctrlAnnAfter === 2 && ctrlAnnAfter === 0,
    );

    /* ===== HELD PHASE — held subjects must be retained (req 2) ===== */

    await runInNewTenantTransaction(db, orgIdA, async () => {
      await db.insert(hrLegalHolds).values({
        orgId: orgIdA,
        subjectUserId: userHeldId,
        reason: `retention-drill-${runId}`,
        placedBy: userNormalId,
      });
      await db.insert(helpdeskTickets).values([
        {
          orgId: orgIdA,
          userId: userHeldId,
          title: `held-h1-${runId}`,
          status: "RESOLVED",
          resolvedAt: HELPDESK_EXP,
        },
        {
          orgId: orgIdA,
          userId: userHeldId,
          title: `held-h2-${runId}`,
          status: "RESOLVED",
          resolvedAt: HELPDESK_EXP,
        },
        {
          orgId: orgIdA,
          userId: userNormalId,
          title: `held-n1-${runId}`,
          status: "RESOLVED",
          resolvedAt: HELPDESK_EXP,
        },
      ]);
      await db.insert(mailMessageMetadata).values([
        {
          orgId: orgIdA,
          accountId: DRILL_ACCOUNT_ID,
          messageId: `hm-held-${runId}`,
          userMembershipId: memberHeldId,
          syncedAt: MAIL_EXP,
        },
        {
          orgId: orgIdA,
          accountId: DRILL_ACCOUNT_ID,
          messageId: `hm-norm-${runId}`,
          userMembershipId: memberNormalId,
          syncedAt: MAIL_EXP,
        },
      ]);
      await db.insert(announcements).values([
        {
          orgId: orgIdA,
          title: `held-ann-h-${runId}`,
          content: "drill",
          authorId: userHeldId,
          expiresAt: ANN_EXP,
        },
        {
          orgId: orgIdA,
          title: `held-ann-n-${runId}`,
          content: "drill",
          authorId: userNormalId,
          expiresAt: ANN_EXP,
        },
      ]);
    });

    const heldTicketsBefore = await countTickets(db, orgIdA, userHeldId);
    const normTicketsBefore = await countTickets(db, orgIdA, userNormalId);
    const heldMailBefore = await countMail(db, orgIdA, memberHeldId);
    const normMailBefore = await countMail(db, orgIdA, memberNormalId);
    const heldAnnBefore = await countAnnouncements(db, orgIdA, userHeldId);
    const normAnnBefore = await countAnnouncements(db, orgIdA, userNormalId);

    await helpdeskSvc.sweep();
    await mailSvc.sweep();
    await announceSvc.sweep();

    const heldTicketsAfter = await countTickets(db, orgIdA, userHeldId);
    const normTicketsAfter = await countTickets(db, orgIdA, userNormalId);
    const heldMailAfter = await countMail(db, orgIdA, memberHeldId);
    const normMailAfter = await countMail(db, orgIdA, memberNormalId);
    const heldAnnAfter = await countAnnouncements(db, orgIdA, userHeldId);
    const normAnnAfter = await countAnnouncements(db, orgIdA, userNormalId);

    record(
      "held.helpdesk.protected",
      "held",
      "CronHelpdeskRetentionService.sweep",
      "held user's 2 expired tickets NOT deleted by sweep",
      `before=${heldTicketsBefore} after=${heldTicketsAfter}`,
      heldTicketsAfter === heldTicketsBefore && heldTicketsBefore > 0,
    );
    record(
      "held.helpdesk.normal_deleted",
      "held",
      "CronHelpdeskRetentionService.sweep",
      "unheld user's 1 expired ticket deleted (1 recent TODO survives)",
      `before=${normTicketsBefore} after=${normTicketsAfter}`,
      normTicketsAfter < normTicketsBefore && normTicketsAfter > 0,
    );
    record(
      "held.mail.protected",
      "held",
      "CronMailRetentionService.sweep",
      "held membership's expired mail row NOT deleted",
      `before=${heldMailBefore} after=${heldMailAfter}`,
      heldMailAfter === heldMailBefore && heldMailBefore > 0,
    );
    record(
      "held.mail.normal_deleted",
      "held",
      "CronMailRetentionService.sweep",
      "unheld membership's expired mail row deleted",
      `before=${normMailBefore} after=${normMailAfter}`,
      normMailAfter < normMailBefore,
    );
    record(
      "held.announcements.protected",
      "held",
      "CronAnnouncementsRetentionService.sweep",
      "held author's expired announcement NOT deleted",
      `before=${heldAnnBefore} after=${heldAnnAfter}`,
      heldAnnAfter === heldAnnBefore && heldAnnBefore > 0,
    );
    record(
      "held.announcements.normal_deleted",
      "held",
      "CronAnnouncementsRetentionService.sweep",
      "unheld author's expired announcement deleted",
      `before=${normAnnBefore} after=${normAnnAfter}`,
      normAnnAfter < normAnnBefore,
    );

    /* ===== ISOLATION PHASE — holds are org-scoped; orgB is not cross-contaminated (req 3) ===== */

    await runInNewTenantTransaction(db, orgIdB, async () => {
      await db.insert(helpdeskTickets).values([
        {
          orgId: orgIdB,
          userId: userHeldId,
          title: `iso-1-${runId}`,
          status: "RESOLVED",
          resolvedAt: HELPDESK_EXP,
        },
        {
          orgId: orgIdB,
          userId: userHeldId,
          title: `iso-2-${runId}`,
          status: "RESOLVED",
          resolvedAt: HELPDESK_EXP,
        },
      ]);
    });

    const orgBSeeded = await countTickets(db, orgIdB, userHeldId);
    const orgAHeldBefore = await countTickets(db, orgIdA, userHeldId);

    await helpdeskSvc.sweep();

    const orgBAfter = await countTickets(db, orgIdB, userHeldId);
    const orgAHeldAfter = await countTickets(db, orgIdA, userHeldId);

    record(
      "isolated.helpdesk.orgb_deleted",
      "isolated",
      "CronHelpdeskRetentionService.sweep",
      "orgB tickets for userHeld deleted — hold in orgA does not cross into orgB",
      `orgBSeeded=${orgBSeeded} orgBAfter=${orgBAfter}`,
      orgBAfter < orgBSeeded && orgBSeeded > 0,
    );
    record(
      "isolated.helpdesk.orga_protected",
      "isolated",
      "CronHelpdeskRetentionService.sweep",
      "orgA hold still protects userHeld's tickets after orgB sweep ran",
      `orgABefore=${orgAHeldBefore} orgAAfter=${orgAHeldAfter}`,
      orgAHeldAfter === orgAHeldBefore && orgAHeldAfter > 0,
    );

    /* ===== IDEMPOTENCY PHASE — re-run is safe (req 4) ===== */

    const idempBefore = await countTickets(db, orgIdA, userHeldId);
    await helpdeskSvc.sweep();
    const idempAfter = await countTickets(db, orgIdA, userHeldId);

    record(
      "idempotent.helpdesk",
      "idempotent",
      "CronHelpdeskRetentionService.sweep (second identical run)",
      "held rows unchanged — sweep is safe to retry",
      `before=${idempBefore} after=${idempAfter}`,
      idempAfter === idempBefore && idempBefore > 0,
    );

    /* ===== BATCH PHASE — cursor loops; no silent truncation (req 5) ===== */

    const batchCount = HELPDESK_BATCH_SIZE + 1;
    const batchRows = Array.from({ length: batchCount }, (_, i) => ({
      orgId: orgIdA,
      userId: userNormalId,
      title: `batch-${i}-${runId}`,
      status: "RESOLVED" as const,
      resolvedAt: HELPDESK_EXP,
    }));
    await runInNewTenantTransaction(db, orgIdA, async () => {
      for (let i = 0; i < batchRows.length; i += 100)
        await db.insert(helpdeskTickets).values(batchRows.slice(i, i + 100));
    });

    const batchBefore = await countTickets(db, orgIdA, userNormalId);
    const batchResult = await helpdeskSvc.sweep();
    const batchAfter = await countTickets(db, orgIdA, userNormalId);
    const batchDeleted = batchBefore - batchAfter;

    record(
      "batch.helpdesk.all_deleted",
      "batch",
      "CronHelpdeskRetentionService.sweep (BATCH_SIZE+1 rows)",
      `all ${batchCount} expired rows deleted; sweep must loop across multiple batches`,
      `seeded=${batchCount} before=${batchBefore} after=${batchAfter} deleted=${batchDeleted}`,
      batchDeleted >= batchCount,
    );
    record(
      "batch.helpdesk.not_truncated",
      "batch",
      "CronHelpdeskRetentionService.sweep (HelpdeskRetentionResult.truncated)",
      "truncated=false for fixture org — cursor drained completely, no silent truncation",
      `truncated=${batchResult.truncated} totalDeleted=${batchResult.ticketsDeleted}`,
      !batchResult.truncated,
    );

    return { mode: "run", checks };
  } catch (err) {
    const msg =
      err instanceof Error
        ? `${err.constructor.name}: ${err.message}`
        : String(err);
    return { mode: "run", checks, error: msg };
  } finally {
    await cleanup(
      db,
      orgIdA,
      orgIdB,
      userHeldId,
      userNormalId,
      memberHeldId,
      memberNormalId,
      runId,
    ).catch((e: unknown) => {
      process.stderr.write(
        `[retention-drill-probe] cleanup failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    });
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
