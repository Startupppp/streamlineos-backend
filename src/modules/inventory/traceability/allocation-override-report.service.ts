import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, lt, type SQL } from "drizzle-orm";
import { businessParties, clientPartyMap, invAllocationOverrides, users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { buildCursorPage, decodeTimestampCursor } from "../../../common/pagination/cursor";
import { keysetBeforeMicros, microsecondCursorValue } from "../../../common/pagination/keyset";
import type { ListAllocationOverridesInput } from "./dto/allocation-overrides.schemas";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * D2 — "who shipped the short-dated stock, and why."
 *
 * The question this exists to answer is asked six months late, by somebody
 * holding a customer complaint or a recall notice, and it has four parts: which
 * lot, to whom, on whose authority, and for what stated reason. `inv_audit_events`
 * holds the first three thinly and the fourth in a JSONB column its own list
 * endpoint deliberately does not project — so the trail was written and
 * unreadable. `inv_allocation_overrides` is the same decision as typed columns,
 * and this reads it.
 *
 * The reason IS projected here, unlike the audit list. That is not a relaxation
 * of D7's redaction line but the point of the record: an override reason is
 * written to be read by a reviewer, it is bounded free text the writer knew was
 * a justification, and a trail whose "why" cannot be retrieved is a bypass with
 * paperwork. It sits behind `inventory:audit:read`, the same key the audit trail
 * itself does.
 *
 * Keyset-paginated on `(created_at, id)` for the reason every append-only list
 * here is: one confirm can write several rows inside one transaction, so
 * `created_at` alone repeats and a cursor on it would skip or duplicate at a
 * page boundary.
 */
@Injectable()
export class AllocationOverrideReportService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string, query: ListAllocationOverridesInput) {
    const { lotId, clientId, productVariantId, verdict, actorUserId, fromDate, toDate, limit, cursor } =
      query;
    const position = decodeTimestampCursor(cursor);

    const conditions: SQL[] = [eq(invAllocationOverrides.orgId, orgId)];
    if (lotId !== undefined) conditions.push(eq(invAllocationOverrides.lotId, lotId));
    if (clientId !== undefined) conditions.push(eq(invAllocationOverrides.clientId, clientId));
    if (productVariantId !== undefined)
      conditions.push(eq(invAllocationOverrides.productVariantId, productVariantId));
    if (verdict) conditions.push(eq(invAllocationOverrides.verdict, verdict));
    if (actorUserId) conditions.push(eq(invAllocationOverrides.actorUserId, actorUserId));
    if (fromDate)
      conditions.push(gte(invAllocationOverrides.createdAt, new Date(`${fromDate}T00:00:00.000Z`)));
    // The whole of `toDate` is in the window, so the bound is the day after it.
    if (toDate)
      conditions.push(
        lt(
          invAllocationOverrides.createdAt,
          new Date(new Date(`${toDate}T00:00:00.000Z`).getTime() + MS_PER_DAY),
        ),
      );
    if (position)
      conditions.push(
        keysetBeforeMicros(invAllocationOverrides.createdAt, invAllocationOverrides.id, position),
      );

    const rows = await this.db
      .select({
        id: invAllocationOverrides.id,
        // Who, and under what stated reason — the two halves of "audited".
        actorUserId: invAllocationOverrides.actorUserId,
        actorName: users.name,
        reason: invAllocationOverrides.reason,
        // Which rule was set aside, and how far the lot actually was from it.
        verdict: invAllocationOverrides.verdict,
        lotId: invAllocationOverrides.lotId,
        lotNumber: invAllocationOverrides.lotNumber,
        lotExpiryDate: invAllocationOverrides.lotExpiryDate,
        daysRemaining: invAllocationOverrides.daysRemaining,
        // The policy as it stood, so the row still explains itself after the
        // settings behind it have been edited.
        nearExpiryPolicy: invAllocationOverrides.nearExpiryPolicy,
        nearExpiryWindowDays: invAllocationOverrides.nearExpiryWindowDays,
        minShelfLifeDays: invAllocationOverrides.minShelfLifeDays,
        // And where it went.
        productVariantId: invAllocationOverrides.productVariantId,
        sourceType: invAllocationOverrides.sourceType,
        sourceId: invAllocationOverrides.sourceId,
        clientId: invAllocationOverrides.clientId,
        clientName: businessParties.name,
        reservationId: invAllocationOverrides.reservationId,
        createdAt: invAllocationOverrides.createdAt,
        cursorAt: microsecondCursorValue(invAllocationOverrides.createdAt),
      })
      .from(invAllocationOverrides)
      // §3: the users relation is never unprojected — those rows still hold
      // authentication secrets. Name only, joined explicitly.
      .leftJoin(users, eq(users.id, invAllocationOverrides.actorUserId))
      // The customer's name comes from the Party, through the map — `clients` is
      // being retired and is barred at the import. A per-row `resolveLegacyParty`
      // is the seam's single-record entry point and would be an N+1 on a page of
      // a hundred; its list helper returns party ids only, so the join is spelled
      // out here over the same two tables that helper walks.
      .leftJoin(
        clientPartyMap,
        and(
          eq(clientPartyMap.organizationId, orgId),
          eq(clientPartyMap.clientId, invAllocationOverrides.clientId),
        ),
      )
      .leftJoin(
        businessParties,
        and(
          eq(businessParties.organizationId, orgId),
          eq(businessParties.partyId, clientPartyMap.partyId),
        ),
      )
      .where(and(...conditions))
      .orderBy(desc(invAllocationOverrides.createdAt), desc(invAllocationOverrides.id))
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
