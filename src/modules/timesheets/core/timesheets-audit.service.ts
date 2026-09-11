import { createHash } from "node:crypto";
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

export interface AuditEventParams {
  orgId: string;
  actorMembershipId: number | null;
  entityType: string;
  entityId: string;
  action: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

type DbLike = Pick<Db, "insert" | "select">;

/** JSON.stringify with recursively sorted object keys, so hashes survive
 *  Postgres jsonb round-trips (jsonb does not preserve key order). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const withToJson = value as { toJSON?: () => unknown };
  if (typeof withToJson.toJSON === "function") {
    return stableStringify(withToJson.toJSON());
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v === undefined ? null : v)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

export function computeAuditRowHash(
  prevHash: string | null,
  params: AuditEventParams,
): string {
  const canonical = stableStringify({
    prevHash: prevHash ?? "",
    orgId: params.orgId,
    actorMembershipId: String(params.actorMembershipId ?? ""),
    entityType: params.entityType,
    entityId: params.entityId,
    action: params.action,
    before: params.before ?? null,
    after: params.after ?? null,
    reason: params.reason ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

@Injectable()
export class TimesheetsAuditService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async record(dbOrTx: DbLike, params: AuditEventParams): Promise<void> {
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
      before: (params.before ?? null) as Record<string, unknown> | null,
      after: (params.after ?? null) as Record<string, unknown> | null,
      reason: params.reason ?? null,
      prevHash,
      rowHash,
    });
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
  async verifyChain(orgId: string, limit = 10_000) {
    const [counted] = await this.db
      .select({ n: sql<string>`count(*)` })
      .from(timesheetAuditEvents)
      .where(eq(timesheetAuditEvents.orgId, orgId));
    const total = Number(counted?.n ?? 0);

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
      })
      .from(timesheetAuditEvents)
      .where(eq(timesheetAuditEvents.orgId, orgId))
      .orderBy(asc(timesheetAuditEvents.id))
      .limit(limit);

    let prevHash: string | null = null;
    let legacyRows = 0;
    let verified = 0;

    for (const row of rows) {
      if (!row.rowHash) {
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
      if (expected !== row.rowHash || (row.prevHash ?? null) !== prevHash) {
        if (row.actorMembershipId === null) {
          legacyRows++;
          prevHash = row.rowHash;
          continue;
        }
        return {
          valid: false,
          brokenAtId: row.id,
          checked: verified + legacyRows,
          verified,
          legacyRows,
          total,
          /* A break found early says nothing about what lies past the cut. */
          truncated: total > rows.length,
        };
      }
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
