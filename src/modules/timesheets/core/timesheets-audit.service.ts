import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { timesheetAuditEvents, users } from "../../../db/schema";
import type { AuditQuery } from "./dto/audit.schemas";

export interface AuditEventParams {
  orgId: string;
  actorUserId: string;
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
    actorUserId: params.actorUserId,
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
    // Hash-chain per org: each row commits to the previous row's hash, making
    // deletion or mutation of history detectable via verifyChain().
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
      actorUserId: params.actorUserId,
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
    const offset = (query.page - 1) * limit;

    const conditions = [eq(timesheetAuditEvents.orgId, orgId)];
    if (query.entityType)
      conditions.push(eq(timesheetAuditEvents.entityType, query.entityType));
    if (query.entityId)
      conditions.push(eq(timesheetAuditEvents.entityId, query.entityId));
    if (query.action)
      conditions.push(eq(timesheetAuditEvents.action, query.action));

    const rows = await this.db
      .select({
        id: timesheetAuditEvents.id,
        actorUserId: timesheetAuditEvents.actorUserId,
        actorName: users.name,
        entityType: timesheetAuditEvents.entityType,
        entityId: timesheetAuditEvents.entityId,
        action: timesheetAuditEvents.action,
        before: timesheetAuditEvents.before,
        after: timesheetAuditEvents.after,
        reason: timesheetAuditEvents.reason,
        createdAt: timesheetAuditEvents.createdAt,
        windowTotal: sql<string>`count(*) OVER ()`,
      })
      .from(timesheetAuditEvents)
      .leftJoin(users, eq(timesheetAuditEvents.actorUserId, users.id))
      .where(and(...conditions))
      .orderBy(desc(timesheetAuditEvents.createdAt))
      .limit(limit)
      .offset(offset);

    const first = rows[0];
    let total: number;
    if (first) {
      total = Number(first.windowTotal);
    } else if (offset === 0) {
      total = 0;
    } else {
      const fallback = await this.db
        .select({ n: sql<string>`count(*)` })
        .from(timesheetAuditEvents)
        .where(and(...conditions));
      total = Number(fallback[0]?.n ?? 0);
    }

    return {
      data: rows.map(({ windowTotal: _, ...r }) => r),
      total,
    };
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
      .select()
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
        actorUserId: row.actorUserId ?? "",
        entityType: row.entityType,
        entityId: row.entityId,
        action: row.action,
        before: row.before,
        after: row.after,
        reason: row.reason ?? undefined,
      });
      if (expected !== row.rowHash || (row.prevHash ?? null) !== prevHash) {
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
