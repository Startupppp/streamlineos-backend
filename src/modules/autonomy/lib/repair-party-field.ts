/**
 * The one party column a repair class touches: reading what is on the record
 * now, and the patch that writes it back through the mirror.
 *
 * Shared by the repair pass and the revert path, which ask the same question
 * of the same row — a repair is proposed from the current value, and an undo
 * is refused unless the current value is still the one the system wrote.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.types";
import { businessParties } from "../../../db/schema";

/**
 * The patch, written as a branch rather than a computed key.
 *
 * `{ [field]: value }` widens to an index signature, which `PartyPatch` does not
 * accept — and rightly so: the mirror derives a legacy row from every column it
 * is handed, so a patch whose keys the compiler cannot see is a patch whose
 * mirror nobody can check.
 */
export function fieldPatch(field: "email" | "phone", value: string | null) {
  return field === "email" ? { email: value } : { phone: value };
}

export async function currentPartyFieldValue(
  db: Db,
  organizationId: string,
  partyId: string,
  field: "email" | "phone",
): Promise<string | null> {
  const [row] = await db
    .select({ email: businessParties.email, phone: businessParties.phone })
    .from(businessParties)
    .where(
      and(
        eq(businessParties.organizationId, organizationId),
        eq(businessParties.partyId, partyId),
        isNull(businessParties.deletedAt),
      ),
    )
    .limit(1);

  const value = field === "email" ? row?.email : row?.phone;
  return value && value.trim().length > 0 ? value : null;
}
