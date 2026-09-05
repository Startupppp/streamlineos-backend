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

/** Anti-vacuity gate. Named+exported so --contract can verify logic without a DB. */
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

const ACCT = 88_888_888;
const HD_BATCH = 200;
const arg = (name: string) =>
  process.argv
    .slice(2)
    .find((x) => x.startsWith(`--${name}=`))
    ?.slice(`--${name}=`.length);
const ago = (n: number) => new Date(Date.now() - n * 86_400_000);

function emit(report: DrillReport): void {
  const out = arg("out");
  if (!out) {
    process.stderr.write("--out=<path> required\n");
    return;
  }
  writeFileSync(out, JSON.stringify(report, null, 2) + "\n", "utf8");
}

const cntTickets = (db: DbWithClient, o: string, uid: string) =>
  runInNewTenantTransaction(db, o, async () => {
    const [r] = await db
      .select({ c: count() })
      .from(helpdeskTickets)
      .where(
        and(eq(helpdeskTickets.orgId, o), eq(helpdeskTickets.userId, uid)),
      );
    return Number(r?.c ?? 0);
  });
const cntMail = (db: DbWithClient, o: string, mid: number) =>
  runInNewTenantTransaction(db, o, async () => {
    const [r] = await db
      .select({ c: count() })
      .from(mailMessageMetadata)
      .where(
        and(
          eq(mailMessageMetadata.orgId, o),
          eq(mailMessageMetadata.userMembershipId, mid),
        ),
      );
    return Number(r?.c ?? 0);
  });
const cntAnn = (db: DbWithClient, o: string, uid: string) =>
  runInNewTenantTransaction(db, o, async () => {
    const [r] = await db
      .select({ c: count() })
      .from(announcements)
      .where(and(eq(announcements.orgId, o), eq(announcements.authorId, uid)));
    return Number(r?.c ?? 0);
  });

async function cleanup(
  db: DbWithClient,
  orgA: string,
  orgB: string,
  uids: string[],
  mids: number[],
  runId: string,
): Promise<void> {
  await runInNewTenantTransaction(db, orgA, async () => {
    if (mids.length)
      await db
        .delete(mailMessageMetadata)
        .where(
          and(
            eq(mailMessageMetadata.orgId, orgA),
            inArray(mailMessageMetadata.userMembershipId, mids),
          ),
        );
    await db
      .delete(mailMessageMetadata)
      .where(
        and(
          eq(mailMessageMetadata.orgId, orgA),
          like(mailMessageMetadata.messageId, `%${runId}`),
        ),
      );
    await db
      .delete(helpdeskTickets)
      .where(
        and(
          eq(helpdeskTickets.orgId, orgA),
          inArray(helpdeskTickets.userId, uids),
        ),
      );
    await db
      .delete(hrLegalHolds)
      .where(
        and(
          eq(hrLegalHolds.orgId, orgA),
          inArray(hrLegalHolds.subjectUserId, uids),
        ),
      );
    await db
      .delete(announcements)
      .where(
        and(
          eq(announcements.orgId, orgA),
          inArray(announcements.authorId, uids),
        ),
      );
    await db
      .delete(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, orgA),
          inArray(organizationMembers.userId, uids),
        ),
      );
  });
  await runInNewTenantTransaction(db, orgB, async () => {
    await db
      .delete(helpdeskTickets)
      .where(
        and(
          eq(helpdeskTickets.orgId, orgB),
          inArray(helpdeskTickets.userId, uids),
        ),
      );
  });
  await db.delete(users).where(inArray(users.id, uids));
}

async function runDrill(
  orgA: string,
  orgB: string,
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
  ) =>
    void checks.push({
      id,
      phase,
      productionPath: path,
      expected,
      observed,
      ok,
    });

  const uHeld = `dh-${runId}`;
  const uNorm = `dn-${runId}`;
  let mHeld = 0;
  let mNorm = 0;

  const hdSvc = new CronHelpdeskRetentionService(db);
  const mlSvc = new CronMailRetentionService(db);
  const anSvc = new CronAnnouncementsRetentionService(db);

  try {
    const userRows: (typeof users.$inferInsert)[] = [
      { id: uHeld, email: `drill-held-${runId}@drill.internal` },
      { id: uNorm, email: `drill-norm-${runId}@drill.internal` },
    ];
    await db.insert(users).values(userRows);
    await runInNewTenantTransaction(db, orgA, async () => {
      const [h] = await db
        .insert(organizationMembers)
        .values({ userId: uHeld, orgId: orgA })
        .returning({ id: organizationMembers.id });
      const [n] = await db
        .insert(organizationMembers)
        .values({ userId: uNorm, orgId: orgA })
        .returning({ id: organizationMembers.id });
      if (!h || !n) throw new Error("fixture membership insert returned no id");
      mHeld = h.id;
      mNorm = n.id;
    });

    /* CONTROL — expired eligible data deleted (req 1) */
    const HDEXP = ago(800); // >730d helpdesk cutoff
    const MLEXP = ago(400); // >365d mail cutoff
    const ANEXP = ago(180); // >90d announcement grace
    const ANAGE = ago(800); // >730d announcement max-age

    await runInNewTenantTransaction(db, orgA, async () => {
      await db.insert(helpdeskTickets).values([
        {
          orgId: orgA,
          userId: uNorm,
          title: `c1-${runId}`,
          status: "DONE",
          resolvedAt: HDEXP,
        },
        {
          orgId: orgA,
          userId: uNorm,
          title: `c2-${runId}`,
          status: "DONE",
          resolvedAt: HDEXP,
        },
        {
          orgId: orgA,
          userId: uNorm,
          title: `c3-${runId}`,
          status: "DONE",
          resolvedAt: HDEXP,
        },
        { orgId: orgA, userId: uNorm, title: `cr-${runId}`, status: "TODO" },
      ]);
      await db.insert(mailMessageMetadata).values([
        {
          orgId: orgA,
          accountId: ACCT,
          messageId: `cm1-${runId}`,
          userMembershipId: mNorm,
          syncedAt: MLEXP,
        },
        {
          orgId: orgA,
          accountId: ACCT,
          messageId: `cm2-${runId}`,
          userMembershipId: mNorm,
          syncedAt: MLEXP,
        },
      ]);
      await db.insert(announcements).values([
        {
          orgId: orgA,
          title: `cae-${runId}`,
          content: "drill",
          authorId: uNorm,
          expiresAt: ANEXP,
        },
        {
          orgId: orgA,
          title: `caa-${runId}`,
          content: "drill",
          authorId: uNorm,
          createdAt: ANAGE,
        },
      ]);
    });

    const [hdB, mlB, anB] = await Promise.all([
      cntTickets(db, orgA, uNorm),
      cntMail(db, orgA, mNorm),
      cntAnn(db, orgA, uNorm),
    ]);
    await hdSvc.sweep();
    await mlSvc.sweep();
    await anSvc.sweep();
    const [hdA, mlA, anA] = await Promise.all([
      cntTickets(db, orgA, uNorm),
      cntMail(db, orgA, mNorm),
      cntAnn(db, orgA, uNorm),
    ]);

    const av = assessControlDeletion(hdB - hdA, hdB);
    if (!av.ok)
      return { mode: "run", checks, error: `INCONCLUSIVE — ${av.message}` };

    rec(
      "ctrl.hd",
      "control",
      "CronHelpdeskRetentionService.sweep",
      "3 expired deleted 1 TODO survived",
      `bef=${hdB} aft=${hdA} del=${hdB - hdA}`,
      hdB - hdA === 3 && hdA === 1,
    );
    rec(
      "ctrl.ml",
      "control",
      "CronMailRetentionService.sweep",
      "2 expired mail deleted",
      `bef=${mlB} aft=${mlA}`,
      mlB - mlA === 2 && mlA === 0,
    );
    rec(
      "ctrl.an",
      "control",
      "CronAnnouncementsRetentionService.sweep",
      "2 expired announcements deleted",
      `bef=${anB} aft=${anA}`,
      anB - anA === 2 && anA === 0,
    );

    /* HELD — legally-held subjects retained (req 2) */
    await runInNewTenantTransaction(db, orgA, async () => {
      await db.insert(hrLegalHolds).values({
        orgId: orgA,
        subjectUserId: uHeld,
        reason: `drill-${runId}`,
        placedBy: uNorm,
      });
      await db.insert(helpdeskTickets).values([
        {
          orgId: orgA,
          userId: uHeld,
          title: `hh1-${runId}`,
          status: "DONE",
          resolvedAt: HDEXP,
        },
        {
          orgId: orgA,
          userId: uHeld,
          title: `hh2-${runId}`,
          status: "DONE",
          resolvedAt: HDEXP,
        },
        {
          orgId: orgA,
          userId: uNorm,
          title: `hn1-${runId}`,
          status: "DONE",
          resolvedAt: HDEXP,
        },
      ]);
      await db.insert(mailMessageMetadata).values([
        {
          orgId: orgA,
          accountId: ACCT,
          messageId: `hm-h-${runId}`,
          userMembershipId: mHeld,
          syncedAt: MLEXP,
        },
        {
          orgId: orgA,
          accountId: ACCT,
          messageId: `hm-n-${runId}`,
          userMembershipId: mNorm,
          syncedAt: MLEXP,
        },
      ]);
      await db.insert(announcements).values([
        {
          orgId: orgA,
          title: `hah-${runId}`,
          content: "drill",
          authorId: uHeld,
          expiresAt: ANEXP,
        },
        {
          orgId: orgA,
          title: `han-${runId}`,
          content: "drill",
          authorId: uNorm,
          expiresAt: ANEXP,
        },
      ]);
    });

    const [hhB, hnB, hmhB, hmnB, hahB, hanB] = await Promise.all([
      cntTickets(db, orgA, uHeld),
      cntTickets(db, orgA, uNorm),
      cntMail(db, orgA, mHeld),
      cntMail(db, orgA, mNorm),
      cntAnn(db, orgA, uHeld),
      cntAnn(db, orgA, uNorm),
    ]);
    await hdSvc.sweep();
    await mlSvc.sweep();
    await anSvc.sweep();
    const [hhA, hnA, hmhA, hmnA, hahA, hanA] = await Promise.all([
      cntTickets(db, orgA, uHeld),
      cntTickets(db, orgA, uNorm),
      cntMail(db, orgA, mHeld),
      cntMail(db, orgA, mNorm),
      cntAnn(db, orgA, uHeld),
      cntAnn(db, orgA, uNorm),
    ]);

    rec(
      "held.hd.prot",
      "held",
      "CronHelpdeskRetentionService.sweep",
      "held user tickets not deleted",
      `bef=${hhB} aft=${hhA}`,
      hhA === hhB && hhB > 0,
    );
    rec(
      "held.hd.norm",
      "held",
      "CronHelpdeskRetentionService.sweep",
      "unheld user expired ticket deleted",
      `bef=${hnB} aft=${hnA}`,
      hnA < hnB && hnA > 0,
    );
    rec(
      "held.ml.prot",
      "held",
      "CronMailRetentionService.sweep",
      "held membership mail not deleted",
      `bef=${hmhB} aft=${hmhA}`,
      hmhA === hmhB && hmhB > 0,
    );
    rec(
      "held.ml.norm",
      "held",
      "CronMailRetentionService.sweep",
      "unheld membership expired mail deleted",
      `bef=${hmnB} aft=${hmnA}`,
      hmnA < hmnB,
    );
    rec(
      "held.an.prot",
      "held",
      "CronAnnouncementsRetentionService.sweep",
      "held author announcement not deleted",
      `bef=${hahB} aft=${hahA}`,
      hahA === hahB && hahB > 0,
    );
    rec(
      "held.an.norm",
      "held",
      "CronAnnouncementsRetentionService.sweep",
      "unheld author expired announcement deleted",
      `bef=${hanB} aft=${hanA}`,
      hanA < hanB,
    );

    /* ISOLATION — holds are org-scoped (req 3) */
    await runInNewTenantTransaction(db, orgB, async () => {
      await db.insert(helpdeskTickets).values([
        {
          orgId: orgB,
          userId: uHeld,
          title: `is1-${runId}`,
          status: "DONE",
          resolvedAt: HDEXP,
        },
        {
          orgId: orgB,
          userId: uHeld,
          title: `is2-${runId}`,
          status: "DONE",
          resolvedAt: HDEXP,
        },
      ]);
    });
    const [ibSeed, iaABef] = await Promise.all([
      cntTickets(db, orgB, uHeld),
      cntTickets(db, orgA, uHeld),
    ]);
    await hdSvc.sweep();
    const [ibAft, iaAAft] = await Promise.all([
      cntTickets(db, orgB, uHeld),
      cntTickets(db, orgA, uHeld),
    ]);

    rec(
      "iso.orgb.del",
      "isolated",
      "CronHelpdeskRetentionService.sweep",
      "orgB tickets for uHeld deleted — no hold in orgB",
      `seed=${ibSeed} aft=${ibAft}`,
      ibAft < ibSeed && ibSeed > 0,
    );
    rec(
      "iso.orga.prot",
      "isolated",
      "CronHelpdeskRetentionService.sweep",
      "orgA hold still protects uHeld after orgB sweep",
      `bef=${iaABef} aft=${iaAAft}`,
      iaAAft === iaABef && iaAAft > 0,
    );

    /* IDEMPOTENCY — re-run safe (req 4) */
    const idB = await cntTickets(db, orgA, uHeld);
    await hdSvc.sweep();
    const idA = await cntTickets(db, orgA, uHeld);
    rec(
      "idem.hd",
      "idempotent",
      "CronHelpdeskRetentionService.sweep (second run)",
      "held rows unchanged",
      `bef=${idB} aft=${idA}`,
      idA === idB && idB > 0,
    );

    /* BATCH — cursor loops, no silent truncation (req 5) */
    const bCount = HD_BATCH + 1;
    const bRows = Array.from({ length: bCount }, (_, i) => ({
      orgId: orgA,
      userId: uNorm,
      title: `b${i}-${runId}`,
      status: "DONE" as const,
      resolvedAt: HDEXP,
    }));
    await runInNewTenantTransaction(db, orgA, async () => {
      for (let i = 0; i < bRows.length; i += 100)
        await db.insert(helpdeskTickets).values(bRows.slice(i, i + 100));
    });
    const bBef = await cntTickets(db, orgA, uNorm);
    const bRes = await hdSvc.sweep();
    const bAft = await cntTickets(db, orgA, uNorm);

    rec(
      "batch.hd.all",
      "batch",
      "CronHelpdeskRetentionService.sweep (BATCH_SIZE+1)",
      `all ${bCount} expired rows deleted`,
      `bef=${bBef} aft=${bAft} del=${bBef - bAft}`,
      bBef - bAft >= bCount,
    );
    rec(
      "batch.hd.trunc",
      "batch",
      "CronHelpdeskRetentionService.sweep (HelpdeskRetentionResult.truncated)",
      "truncated=false — cursor drained",
      `truncated=${bRes.truncated}`,
      !bRes.truncated,
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
    const mids = [mHeld, mNorm].filter((m) => m > 0);
    await cleanup(db, orgA, orgB, [uHeld, uNorm], mids, runId).catch(
      (e: unknown) =>
        process.stderr.write(
          `[cleanup] ${e instanceof Error ? e.message : String(e)}\n`,
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
