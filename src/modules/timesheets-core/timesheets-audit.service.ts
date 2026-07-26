import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { asc, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { timesheetAuditEvents } from "../../db/schema";

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

  /**
   * Walk the org's audit chain oldest→newest and recompute every hash.
   * Returns the first broken link, if any. Rows written before hash-chaining
   * was introduced (rowHash null) are reported as `legacyRows`.
   */
  async verifyChain(orgId: string, limit = 10_000) {
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
          legacyRows,
        };
      }
      prevHash = row.rowHash;
      verified++;
    }

    return { valid: true, checked: verified + legacyRows, verified, legacyRows };
  }
}
