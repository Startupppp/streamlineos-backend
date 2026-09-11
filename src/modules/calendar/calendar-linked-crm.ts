import { NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { deals } from "../../db/schema";
import type { TenantTx } from "../../db/drizzle.types";
import { isLegacyResolved, resolveLegacyParty } from "../party/party-legacy-seam";

/**
 * Authorizes the two CRM object references a calendar event may carry.
 *
 * `createEventSchema` validates `linkedDealId` and `linkedLeadId` as positive integers and
 * nothing more, and both travelled straight into `calendar_events` inside the insert literal.
 * `orgId` sits in that same literal, which is exactly the shape the body-id sweep calls
 * `written-unresolved`: the tenant column on the row being written says nothing about the
 * tenant of the row being referenced. Measured in `pg_constraint`, both columns are `bare-fk`
 * — a single-column reference to `deals(id)` / `leads(id)` with no `org_id` in it — so another
 * organisation's deal id LANDS while an id belonging to nobody raises a foreign-key error.
 * The two answers differ, so the route was both a cross-tenant write and an existence oracle.
 *
 * Call it inside the mutation's transaction and BEFORE the write, so a refused reference
 * leaves nothing behind. A miss is 404, never 403: a 403 on a deal id the caller cannot see
 * would confirm that the deal exists.
 *
 * The lead reference resolves through `resolveLegacyParty` rather than `leads` directly —
 * `leads` is an identity table the Party seam already covers, and a party-backed lookup keeps
 * the same 404-on-miss contract without adding a reader of the table the identity migration is
 * retiring. `deals` has no Party equivalent (it is a pipeline record, not an identity), so it
 * stays a direct read.
 */
export async function assertLinkedCrmRecordsInOrg(
  tx: TenantTx,
  orgId: string,
  linkedDealId: number | null | undefined,
  linkedLeadId: number | null | undefined,
): Promise<void> {
  if (linkedDealId !== undefined && linkedDealId !== null) {
    const found = await tx
      .select({ id: deals.id })
      .from(deals)
      .where(and(eq(deals.id, linkedDealId), eq(deals.orgId, orgId)))
      .limit(1);
    if (found.length === 0) throw new NotFoundException("Deal not found");
  }
  if (linkedLeadId !== undefined && linkedLeadId !== null) {
    const resolved = await resolveLegacyParty(tx, orgId, {
      kind: "LEAD",
      legacyId: linkedLeadId,
    });
    if (!isLegacyResolved(resolved)) throw new NotFoundException("Lead not found");
  }
}
