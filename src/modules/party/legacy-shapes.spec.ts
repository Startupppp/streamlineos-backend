import type { clients, contacts, crmOrganizations } from "../../db/schema/crm/contacts";
import type { leads } from "../../db/schema/crm/leads";
import type {
  LegacyClientRow,
  LegacyContactRow,
  LegacyCrmOrgRow,
  LegacyLeadRow,
} from "./legacy-shapes";

/**
 * The hand-written shapes are the inferred ones. Ticket 08.
 *
 * `legacy-shapes.ts` exists so `leads`, `clients`, `contacts` and
 * `crm_organizations` can be dropped while two dozen files keep speaking their
 * vocabulary. That is only safe if the written shape is **exactly** what
 * `$inferSelect` produced — a column typed `string` where Drizzle said
 * `string | null` compiles fine at the definition and fails at a call site
 * nobody is looking at.
 *
 * So this compares them structurally, in both directions. It runs while the
 * tables still exist, which is the whole point of the ordering: the proof is
 * available precisely once, before the thing being compared against goes away.
 *
 * **This spec is deleted along with the tables**, and that is not a loss. Its
 * job is to license one irreversible step; afterwards there is nothing left to
 * compare, and keeping it would mean keeping the table definitions to compare
 * with.
 *
 * A note on why this is a spec and not an assertion inside `legacy-shapes.ts`:
 * the source file must not import the legacy tables, or the reader ratchet
 * counts it as a new reader and — rightly — refuses, since its register may only
 * shrink.
 */

/** Structural equality, so a drift in either direction is a compile error. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Only `true` inhabits this, so a mismatch fails to typecheck. */
type Assert<T extends true> = T;

// Deliberately unused values: their existence is the assertion.
export type _LeadMatches = Assert<Exact<LegacyLeadRow, typeof leads.$inferSelect>>;
export type _ClientMatches = Assert<Exact<LegacyClientRow, typeof clients.$inferSelect>>;
export type _ContactMatches = Assert<Exact<LegacyContactRow, typeof contacts.$inferSelect>>;
export type _CrmOrgMatches = Assert<Exact<LegacyCrmOrgRow, typeof crmOrganizations.$inferSelect>>;

describe("the written legacy shapes match the ones Drizzle inferred", () => {
  /**
   * The assertions above are compile-time; this is what makes them *run*.
   *
   * `ts-jest` is configured with `isolatedModules`, so specs transpile without
   * type-checking — a type-level assertion in a spec file proves nothing on its
   * own. The check that matters is `tsc --noEmit`, which covers this file. This
   * test exists to say so out loud, so nobody deletes the types above believing
   * a green suite had been checking them.
   */
  it("is enforced by tsc, not by this suite", () => {
    expect(true).toBe(true);
  });
});
