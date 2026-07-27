import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { timesheetAuditEvents, users } from "../../db/schema";
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

    const [totalResult, rows] = await Promise.all([
      this.db
        .select({ total: count() })
        .from(timesheetAuditEvents)
        .where(and(...conditions)),
      this.db
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
        })
        .from(timesheetAuditEvents)
        .leftJoin(users, eq(timesheetAuditEvents.actorUserId, users.id))
        .where(and(...conditions))
        .orderBy(desc(timesheetAuditEvents.createdAt))
        .limit(limit)
        .offset(offset),
    ]);

    return {
      data: rows,
      total: totalResult[0]?.total ?? 0,
    };
  }
}
