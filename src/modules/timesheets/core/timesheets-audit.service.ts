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
      truncated: total > rows.length,
    });

    for (const row of rows) {
      if (!row.rowHash) {
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
