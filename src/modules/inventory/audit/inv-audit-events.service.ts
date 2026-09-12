import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, lt, type SQL } from "drizzle-orm";
import { invAuditEvents, users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { buildCursorPage, decodeTimestampCursor } from "../../../common/pagination/cursor";
import { keysetBeforeMicros, microsecondCursorValue } from "../../../common/pagination/keyset";
import type { ListAuditEventsInput } from "./dto/inv-audit-events.schemas";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

@Injectable()
export class InvAuditEventsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * G1. The inventory audit trail, keyset-paginated on `(created_at, id)`.
   *
   * `created_at` repeats here for the same reason it repeats in the ledger: one
   * posting writes several audit rows inside one transaction and they all carry
   * the same `now()`. `id` is unique per tenant by `uniq_inv_audit_events_org_id`,
   * so the pair is a total order and a page boundary cannot fall inside a group.
   *
   * `before`, `after` and `metadata` are deliberately not projected. They hold
   * free-text reasons and whole record snapshots, and D7 already drew that line
   * — its export hashes those three columns rather than emitting them. A read
   * surface that emitted them would move the redaction boundary without anyone
   * deciding to.
   */
  async list(orgId: string, query: ListAuditEventsInput) {
    const { resourceType, resourceId, action, actorUserId, fromDate, toDate, limit, cursor } = query;
    const position = decodeTimestampCursor(cursor);

    const conditions: SQL[] = [eq(invAuditEvents.orgId, orgId)];
    if (resourceType) conditions.push(eq(invAuditEvents.resourceType, resourceType));
    if (resourceId) conditions.push(eq(invAuditEvents.resourceId, resourceId));
    if (action) conditions.push(eq(invAuditEvents.action, action));
    if (actorUserId) conditions.push(eq(invAuditEvents.actorUserId, actorUserId));
    if (fromDate) conditions.push(gte(invAuditEvents.createdAt, new Date(`${fromDate}T00:00:00.000Z`)));
    // The whole of `toDate` is in the window, so the bound is the day after it.
    if (toDate) conditions.push(lt(invAuditEvents.createdAt, new Date(new Date(`${toDate}T00:00:00.000Z`).getTime() + MS_PER_DAY)));
    if (position) conditions.push(keysetBeforeMicros(invAuditEvents.createdAt, invAuditEvents.id, position));

    const rows = await this.db
      .select({
        id: invAuditEvents.id,
        action: invAuditEvents.action,
        resourceType: invAuditEvents.resourceType,
        resourceId: invAuditEvents.resourceId,
        actorUserId: invAuditEvents.actorUserId,
        actorName: users.name,
        createdAt: invAuditEvents.createdAt,
        cursorAt: microsecondCursorValue(invAuditEvents.createdAt),
      })
      .from(invAuditEvents)
      .leftJoin(users, eq(users.id, invAuditEvents.actorUserId))
      .where(and(...conditions))
      .orderBy(desc(invAuditEvents.createdAt), desc(invAuditEvents.id))
      .limit(limit + 1);

    const page = buildCursorPage(rows, limit, (row) => ({
      sortValue: row.cursorAt,
      id: String(row.id),
    }));

    return {
      items: page.data.map(({ cursorAt: _cursorAt, ...row }) => row),
      ...page.pagination,
    };
  }
}
