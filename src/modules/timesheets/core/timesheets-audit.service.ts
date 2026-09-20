import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { timesheetAuditEvents, organizationMembers, users } from "../../../db/schema";
import {
  buildCursorPage,
  decodeCursor,
} from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";
import type { AuditQuery } from "./dto/audit.schemas";
import type { AuditVerifyResult } from "./dto/timesheets-audit-response.schemas";
import {
  type AuditEventParams,
  stableStringify,
  computeAuditRowHash,
} from "./timesheets-audit-hash";

export type { AuditEventParams };
export { stableStringify, computeAuditRowHash };

type DbLike = Pick<Db, "insert" | "select" | "execute">;

const AUDIT_INSERT_CHUNK = 500;

@Injectable()
export class TimesheetsAuditService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * Serialises the writers of one organisation's chain for the rest of the
   * transaction.
   *
   * Every link commits to the hash of the row before it, so the tail must not
   * move between reading it and inserting. Without this, two approvals landing
   * together both read tail T and both write `prev_hash = T`: the chain forks,
   * and the next verification reports the second, entirely legitimate, row as
   * a break. Neither `ORDER BY id DESC LIMIT 1` nor `FOR UPDATE` on that row
   * closes the window — the second writer's read is not blocked by a lock on
   * a row it is not inserting after. The lock is transaction-scoped and keyed
   * on the organisation, so it costs other tenants nothing and is released
   * with the commit, and it comes before the tail read on purpose.
   */
  private async lockChainTail(dbOrTx: DbLike, orgId: string): Promise<void> {
    await dbOrTx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`timesheets-audit:${orgId}`}, 0))`,
    );
  }

  async record(dbOrTx: DbLike, params: AuditEventParams): Promise<void> {
    await this.lockChainTail(dbOrTx, params.orgId);
    const [last] = await dbOrTx
      .select({ rowHash: timesheetAuditEvents.rowHash })
      .from(timesheetAuditEvents)
      .where(eq(timesheetAuditEvents.orgId, params.orgId))
      .orderBy(desc(timesheetAuditEvents.id))
      .limit(1);

    const prevHash = last?.rowHash ?? null;
    const rowHash = computeAuditRowHash(prevHash, params);

    await dbOrTx.insert(timesheetAuditEvents).values({
      orgId: params.orgId,
      actorMembershipId: params.actorMembershipId ?? null,
      entityType: params.entityType,
      entityId: params.entityId,
      action: params.action,
      before: params.before ?? null,
      after: params.after ?? null,
      reason: params.reason ?? null,
      prevHash,
      rowHash,
    });
  }

  /**
   * The chained form of `record`. The hash chain is sequential by definition, so a
   * bulk action wrote one SELECT plus one INSERT per subject; here the tail hash is
   * read once and the chain is extended in memory, which is exactly what a per-row
   * loop would have produced because every link is derived from its predecessor.
   * The multi-row INSERT keeps VALUES order, so `id` order matches chain order.
   */
  async recordMany(dbOrTx: DbLike, paramsList: readonly AuditEventParams[]): Promise<void> {
    const first = paramsList[0];
    if (!first) return;

    await this.lockChainTail(dbOrTx, first.orgId);
    const [last] = await dbOrTx
      .select({ rowHash: timesheetAuditEvents.rowHash })
      .from(timesheetAuditEvents)
      .where(eq(timesheetAuditEvents.orgId, first.orgId))
      .orderBy(desc(timesheetAuditEvents.id))
      .limit(1);

    let prevHash = last?.rowHash ?? null;
    const rows = paramsList.map((params) => {
      const rowHash = computeAuditRowHash(prevHash, params);
      const row = {
        orgId: params.orgId,
        actorMembershipId: params.actorMembershipId ?? null,
        entityType: params.entityType,
        entityId: params.entityId,
        action: params.action,
        before: params.before ?? null,
        after: params.after ?? null,
        reason: params.reason ?? null,
        prevHash,
        rowHash,
      };
      prevHash = rowHash;
      return row;
    });

    for (let offset = 0; offset < rows.length; offset += AUDIT_INSERT_CHUNK)
      await dbOrTx.insert(timesheetAuditEvents).values(rows.slice(offset, offset + AUDIT_INSERT_CHUNK));
  }

  recordWithDb(params: AuditEventParams): Promise<void> {
    return this.record(this.db, params);
  }

  async listAuditEvents(orgId: string, query: AuditQuery) {
    const limit = Math.min(query.limit, 100);
    const pos = decodeCursor(query.cursor);

    const conditions = [eq(timesheetAuditEvents.orgId, orgId)];
    if (query.entityType)
      conditions.push(eq(timesheetAuditEvents.entityType, query.entityType));
    if (query.entityId)
      conditions.push(eq(timesheetAuditEvents.entityId, query.entityId));
    if (query.action)
      conditions.push(eq(timesheetAuditEvents.action, query.action));
    if (pos)
      conditions.push(
        keysetBeforeId(
          timesheetAuditEvents.createdAt,
          timesheetAuditEvents.id,
          pos,
        ),
      );

    const actorMember = alias(organizationMembers, "actor_member");

    const rows = await this.db
      .select({
        id: timesheetAuditEvents.id,
        actorMembershipId: timesheetAuditEvents.actorMembershipId,
        actorName: users.name,
        entityType: timesheetAuditEvents.entityType,
        entityId: timesheetAuditEvents.entityId,
        action: timesheetAuditEvents.action,
        before: timesheetAuditEvents.before,
        after: timesheetAuditEvents.after,
        reason: timesheetAuditEvents.reason,
        createdAt: timesheetAuditEvents.createdAt,
      })
      .from(timesheetAuditEvents)
      .leftJoin(actorMember, and(
        eq(timesheetAuditEvents.orgId, actorMember.orgId),
        eq(timesheetAuditEvents.actorMembershipId, actorMember.id),
      ))
      .leftJoin(users, eq(actorMember.userId, users.id))
      .where(and(...conditions))
      .orderBy(
        desc(timesheetAuditEvents.createdAt),
        desc(timesheetAuditEvents.id),
      )
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (r) => ({
      sortValue: r.createdAt.toISOString(),
      id: String(r.id),
    }));
  }

  /**
   * Walk the hash chain and say, honestly, how much of it was walked.
   *
   * The `limit` is real and an organisation will pass it: this reads the
   * OLDEST `limit` events by id, so on a chain longer than that, everything
   * after the cut is never examined and `valid: true` used to come back
   * regardless. A caller had no way to tell "the whole chain is intact" from
   * "the first ten thousand of ninety thousand are intact", which is the
   * difference between an audit trail and a reassuring number.
   *
   * So the result carries `truncated` and `total`. A surface rendering this
   * must say which of the two it is looking at — a green tick over a truncated
   * check is worse than no check, because it is believed.
   */
  async verifyChain(orgId: string, limit = 10_000): Promise<AuditVerifyResult> {
    const rows = await this.db
      .select({
        id: timesheetAuditEvents.id,
        orgId: timesheetAuditEvents.orgId,
        actorMembershipId: timesheetAuditEvents.actorMembershipId,
        entityType: timesheetAuditEvents.entityType,
        entityId: timesheetAuditEvents.entityId,
        action: timesheetAuditEvents.action,
        before: timesheetAuditEvents.before,
        after: timesheetAuditEvents.after,
        reason: timesheetAuditEvents.reason,
        prevHash: timesheetAuditEvents.prevHash,
        rowHash: timesheetAuditEvents.rowHash,
        windowTotal: sql<string>`count(*) OVER ()`,
      })
      .from(timesheetAuditEvents)
      .where(eq(timesheetAuditEvents.orgId, orgId))
      .orderBy(asc(timesheetAuditEvents.id))
      .limit(limit);

    const total = Number(rows[0]?.windowTotal ?? 0);

    let prevHash: string | null = null;
    let legacyRows = 0;
    let verified = 0;

    const broken = (brokenAtId: number): AuditVerifyResult => ({
      valid: false,
      brokenAtId,
      checked: verified + legacyRows,
      verified,
      legacyRows,
      total,
      /* A break found early says nothing about what lies past the cut. */
      truncated: total > rows.length,
    });

    for (const row of rows) {
      if (!row.rowHash) {
        /*
         * Rows have carried a hash since the chain was introduced and nothing
         * writes one without it, so hashless rows can only be a prefix — the
         * events that predate hashing. One appearing after a hashed row means
         * a hash was erased, and erasing the hash is the cheapest way to hide
         * an edit; it is a break at that row, not a legacy row.
         */
        if (verified > 0) return broken(row.id);
        legacyRows++;
        continue;
      }
      const expected = computeAuditRowHash(prevHash, {
        orgId: row.orgId,
        actorMembershipId: row.actorMembershipId,
        entityType: row.entityType,
        entityId: row.entityId,
        action: row.action,
        before: row.before,
        after: row.after,
        reason: row.reason ?? undefined,
      });
      /*
       * No row is forgiven for who wrote it. A mismatch used to be waved
       * through when `actorMembershipId` was null — meant for rows whose actor
       * a membership cutover could not map, it also covered every row the
       * system writes (detection sweeps, cron locks) and every row a departed
       * member's foreign key had nulled, and re-anchored the chain on whatever
       * hash the row now carried. An altered system row therefore verified.
       * The cutover left no such rows behind (measured: none on the shared
       * database, 2026-09-12), and migration 1104 stops the departure path
       * rewriting the actor, so the tolerance has nothing left to excuse.
       */
      if (expected !== row.rowHash || (row.prevHash ?? null) !== prevHash) return broken(row.id);
      prevHash = row.rowHash;
      verified++;
    }

    return {
      valid: true,
      checked: verified + legacyRows,
      verified,
      legacyRows,
      total,
      truncated: total > rows.length,
    };
  }
}
