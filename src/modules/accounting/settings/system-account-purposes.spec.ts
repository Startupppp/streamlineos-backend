import { accSystemPurposeEnum } from "../../../db/schema/accounting/accounting-core";
import { DEFAULT_COA } from "../posting/journal-posting.service";
import { PURPOSE_DEFAULT_CODE } from "../posting/finance-posting-accounts.service";
import { PURPOSE_ALLOWED_TYPES, PURPOSE_SUGGESTED_CODE } from "./accounting-settings.constants";
import { systemAccountPurposeSchema, type SystemAccountPurpose } from "./dto/settings.schemas";

/**
 * INV-09 — the five places that name a system-account purpose, held together.
 *
 * A purpose is written down five times: the Postgres enum (mirrored by
 * `accSystemPurposeEnum`), the zod enum the controller validates its route param
 * against, the allowed-account-types map, the suggestion the settings screen
 * shows, and the code posting falls back to when a tenant has mapped nothing.
 * Two of those are `Record<SystemAccountPurpose, …>` and the compiler keeps them
 * complete. The other three it cannot relate to each other at all:
 *
 *   - The pgEnum is a list of string literals. A purpose accepted by zod but
 *     missing from the database type is a `22P02 invalid input value` at the
 *     moment an admin saves the mapping, not at build time.
 *   - The suggestion and the posting fallback are separate maps in separate
 *     modules. When they disagree, the screen offers one account and posting
 *     uses another, and the tenant's ledger depends on whether anyone ever
 *     opened the settings page.
 *
 * There was no test for any of this before INV-09; these were the first.
 */

const PURPOSES = systemAccountPurposeSchema.options;

/**
 * `REIMBURSEMENT_PAYABLE` suggests 2400 (Bonus Payable) and posts to 2000
 * (Accounts Payable). Pre-existing and left alone deliberately: changing either
 * side moves real money in real tenants' ledgers, and which one is right is an
 * accounting decision, not a tidy-up. Baselined rather than skipped so the
 * divergence is written down and cannot grow — a second entry here fails the
 * gate, and this one may only be removed by fixing it.
 */
const SUGGESTION_DIFFERS_FROM_POSTING: ReadonlySet<SystemAccountPurpose> = new Set([
  "REIMBURSEMENT_PAYABLE",
]);

describe("system account purposes", () => {
  it("has not lost the vocabulary it is checking", () => {
    // Anti-vacuity: every assertion below iterates PURPOSES, so an empty or
    // truncated list would pass all of them without checking anything.
    expect(PURPOSES.length).toBeGreaterThanOrEqual(24);
    expect(new Set(PURPOSES).size).toBe(PURPOSES.length);
  });

  it("offers exactly the labels the database type accepts", () => {
    // The one pairing nothing else can catch: zod validates the route param,
    // Postgres stores the column, and neither knows about the other.
    expect([...PURPOSES].sort()).toEqual([...accSystemPurposeEnum.enumValues].sort());
  });

  it("gives every purpose an allowed account type and a suggested code", () => {
    for (const purpose of PURPOSES) {
      expect(PURPOSE_ALLOWED_TYPES[purpose]?.length ?? 0).toBeGreaterThan(0);
      expect(PURPOSE_SUGGESTED_CODE[purpose]).toBeTruthy();
      expect(PURPOSE_DEFAULT_CODE[purpose]).toBeTruthy();
    }
  });

  it("suggests the same account it would post to", () => {
    const differing = PURPOSES.filter(
      (purpose) => PURPOSE_SUGGESTED_CODE[purpose] !== PURPOSE_DEFAULT_CODE[purpose],
    );
    expect([...differing].sort()).toEqual([...SUGGESTION_DIFFERS_FROM_POSTING].sort());
  });

  it("points every purpose at an account the seeder actually creates", () => {
    // The check that stops a code being invented. A purpose whose default code
    // is absent from DEFAULT_COA throws "Seed COA first" at posting time, and a
    // suggestion for an account the tenant does not have is a blank row on the
    // settings screen with no explanation.
    const seeded = new Set(DEFAULT_COA.map((account) => account.code));
    for (const purpose of PURPOSES) {
      expect(seeded.has(PURPOSE_SUGGESTED_CODE[purpose])).toBe(true);
      expect(seeded.has(PURPOSE_DEFAULT_CODE[purpose])).toBe(true);
    }
  });

  it("suggests an account of a type it would actually accept", () => {
    // `upsertSystemAccount` rejects an account whose type is not in
    // PURPOSE_ALLOWED_TYPES. A suggestion that fails that check is a screen
    // offering a choice it will not accept.
    const byCode = new Map(DEFAULT_COA.map((account) => [account.code, account.accountType]));
    for (const purpose of PURPOSES) {
      const suggested = byCode.get(PURPOSE_SUGGESTED_CODE[purpose]);
      expect(PURPOSE_ALLOWED_TYPES[purpose]).toContain(suggested);
    }
  });

  describe("INV-09 — inventory's six", () => {
    const INVENTORY_PURPOSES = [
      "INVENTORY_ASSET",
      "INVENTORY_COGS",
      "INVENTORY_GRNI",
      "INVENTORY_LANDED_COST_CLEARING",
      "INVENTORY_WRITE_OFF",
      "INVENTORY_ADJUSTMENT_GAIN_LOSS",
    ] as const;

    it("names all six the ticket asks for", () => {
      for (const purpose of INVENTORY_PURPOSES) expect(PURPOSES).toContain(purpose);
    });

    it("defaults to the codes inventory's journals already post to", () => {
      // This is what makes adding the purposes a no-op for every existing
      // tenant: the defaults are the literals in `receipt-journal.ts`,
      // `so-fulfillment.service.ts` and `landed-cost-apply.service.ts`. If one
      // of these drifts, adding a mapping silently moves a tenant's postings.
      expect(PURPOSE_DEFAULT_CODE.INVENTORY_ASSET).toBe("1300");
      expect(PURPOSE_DEFAULT_CODE.INVENTORY_COGS).toBe("5000");
      // Both credit the payable today; see PAYABLE_ACCOUNT in
      // landed-cost-apply.service.ts for why landed cost is not a clearing
      // account yet, and INV-38 in the handoff for the rest of that argument.
      expect(PURPOSE_DEFAULT_CODE.INVENTORY_GRNI).toBe("2000");
      expect(PURPOSE_DEFAULT_CODE.INVENTORY_LANDED_COST_CLEARING).toBe("2000");
    });

    it("keeps the two credit-side purposes on the liability side", () => {
      expect(PURPOSE_ALLOWED_TYPES.INVENTORY_GRNI).toEqual(["LIABILITY"]);
      expect(PURPOSE_ALLOWED_TYPES.INVENTORY_LANDED_COST_CLEARING).toEqual(["LIABILITY"]);
    });
  });
});
