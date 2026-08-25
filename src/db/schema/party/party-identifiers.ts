import { randomUUID } from "node:crypto";
import { pgTable, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";

/**
 * Every address a party can be reached at, one row per address.
 *
 * A row per identifier rather than a column per channel, for the reason ticket
 * 01 refused `clients.is_vendor` a column and made it a `party_roles` row: a
 * party has many, of varying kinds, and the set grows with the product. A
 * column and a matching branch per kind means the fifth channel pays exactly
 * what the fourth paid, and it is ambiguous on arrival — a phone number could
 * match `phone` or `whatsapp_phone`, and nothing says which wins.
 *
 * `business_parties.email`, `.phone` and `.whatsapp_phone` stay, as display
 * fields. They stop being the matching mechanism. Ingress resolves a sender
 * here and nowhere else.
 *
 * `kind` is deliberately plain `text` rather than a Drizzle-typed column. The
 * vocabulary belongs to the ingress seam (`IDENTIFIER_KINDS` in
 * `modules/ingress/inbound-event.ts`), which is the file every adapter already
 * imports and which imports nothing itself; `db/schema` importing a module
 * would invert the dependency for a compile-time nicety. The database's copy of
 * the list is the CHECK constraint in 0260, and `party-identifiers.spec.ts`
 * fails if the two ever disagree.
 */
export const partyIdentifiers = pgTable(
  "party_identifiers",
  {
    partyIdentifierId: text("party_identifier_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    partyId: text("party_id").notNull(),
    /** `email` · `phone` · `whatsapp` · `handle`, and nothing else — see the CHECK in 0260. */
    kind: text("kind").notNull(),
    /**
     * What arrived, verbatim.
     *
     * Kept beside the normalised form because it is what a person recognises:
     * `+44 20 7123 4567` is the number on the customer's signature block, and
     * showing them `+442071234567` back reads as a system that mangled it.
     */
    value: text("value").notNull(),
    /**
     * The same identifier reduced to one shape per kind, and the only thing
     * ever matched on.
     *
     * Stored rather than computed at query time so the uniqueness below is a
     * constraint the database enforces rather than a convention every caller
     * has to remember. `normaliseIdentifier` is the one function that produces
     * it; 0260's backfill is the only other place the rule is written, and the
     * opt-in database test asserts the two agree.
     */
    normalisedValue: text("normalised_value").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    /**
     * One party per identifier, per organisation. Not "usually" — enforced.
     *
     * Two parties holding one phone number is the failure this whole table
     * exists to make impossible: the resolver would pick whichever row came
     * back first, so the same caller would land on one record today and the
     * other tomorrow, and neither would ever look wrong.
     */
    uniqueIndex("uniq_party_identifiers_value").on(t.organizationId, t.kind, t.normalisedValue),
    // The reverse read: everything this party is reachable at, which is what a
    // merge moves and what the duplicate scorer compares.
    index("idx_party_identifiers_party").on(t.organizationId, t.partyId, t.kind),
  ],
);
