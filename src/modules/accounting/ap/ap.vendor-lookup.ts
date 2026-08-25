import { NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { glParties, type PartyRole } from "../../../db/schema";
import type { DbOrTx } from "../kernel/sequence.service";

/**
 * The little bit of the party master AP needs.
 *
 * A vendor is not its own table — it is a `gl_parties` row whose `role` is
 * `vendor` or `both`, so the same company can invoice you and be invoiced by
 * you under one identity (A2). This file is a **read**: AP never creates,
 * edits or deletes a party. Party administration belongs to the parties
 * module, and this narrow lookup exists so AP does not have to import it for
 * three columns.
 */

export const PAYABLE_ROLES: readonly PartyRole[] = ["vendor", "both"];

export interface ApVendor {
  id: string;
  displayName: string;
  role: PartyRole;
  countryCode: string;
  defaultCurrency: string;
  billingRegion: string | null;
  billingCountryCode: string | null;
  defaultExpenseAccountId: string | null;
  withholdingCode: string | null;
  paymentTermsDays: number;
}

const VENDOR_COLUMNS = {
  id: glParties.id,
  displayName: glParties.displayName,
  role: glParties.role,
  countryCode: glParties.countryCode,
  defaultCurrency: glParties.defaultCurrency,
  billingRegion: glParties.billingRegion,
  billingCountryCode: glParties.billingCountryCode,
  defaultExpenseAccountId: glParties.defaultExpenseAccountId,
  withholdingCode: glParties.withholdingCode,
  paymentTermsDays: glParties.paymentTermsDays,
};

/**
 * A party this book may be billed by, or a 404.
 *
 * Scoping on `orgId` **and** `bookId` is what makes another tenant's party id
 * resolve to "not found" rather than to a 403 that would confirm it exists
 * (backend/CLAUDE.md §4). A customer-only party is equally "not found" here —
 * it is not a payable party, and saying so precisely would leak the roster.
 */
export async function requireVendor(
  tx: DbOrTx,
  orgId: string,
  bookId: string,
  partyId: string,
): Promise<ApVendor> {
  const [row] = await tx
    .select(VENDOR_COLUMNS)
    .from(glParties)
    .where(
      and(
        eq(glParties.orgId, orgId),
        eq(glParties.bookId, bookId),
        eq(glParties.id, partyId),
        inArray(glParties.role, [...PAYABLE_ROLES]),
        isNull(glParties.deletedAt),
      ),
    )
    .limit(1);

  if (!row) throw new NotFoundException("Vendor not found");
  return row;
}

/** Display names for a batch of parties, for list and report responses. */
export async function loadPartyNames(
  tx: DbOrTx,
  orgId: string,
  partyIds: readonly string[],
): Promise<Map<string, string>> {
  if (partyIds.length === 0) return new Map();
  const rows = await tx
    .select({ id: glParties.id, displayName: glParties.displayName })
    .from(glParties)
    .where(and(eq(glParties.orgId, orgId), inArray(glParties.id, [...new Set(partyIds)])));
  return new Map(rows.map((r) => [r.id, r.displayName]));
}
