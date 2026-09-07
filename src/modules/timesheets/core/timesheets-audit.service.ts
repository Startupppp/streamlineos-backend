import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq } from "drizzle-orm";
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

const AUDIT_INSERT_CHUNK = 500;

/** JSON.stringify with recursively sorted object keys, so hashes survive
 *  Postgres jsonb round-trips (jsonb does not preserve key order). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const toJson: unknown = Reflect.get(value, "toJSON");
  if (typeof toJson === "function") {
    return stableStringify(toJson.call(value));
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v === undefined ? null : v)).join(",")}]`;
  }
  const entries = Object.entries(value)
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

  async verifyChain(orgId: string, limit = 10_000) {
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
          legacyRows,
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
    };
  }
}
