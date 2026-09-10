import { ConflictException } from "@nestjs/common";
import { AccountingSetupService, INVENTORY_SEAM_ROLES } from "./accounting-setup.service";

/**
 * ACC-02: "clear error if enabled but unprovisioned".
 *
 * The state that had no name is an organisation with the accounting module
 * switched on and no book of accounts. `PostingCommandService` raises
 * `BOOK_NOT_ENABLED` for it, and the inventory bridge is *required* to swallow
 * that code (`docs/inventory-gl-contract.md` §3.2) because it is also what an
 * honest opt-out looks like. The two are indistinguishable at the catch site,
 * so the org keeps receiving goods, shipping them and invoicing them while
 * writing no journals at all, and the only symptom is a settings page that
 * looks the same as a settings page for a company that never wanted accounting.
 *
 * The second state is a book that exists and cannot resolve a role the bridge
 * names. That one is worse than silent: it throws, and it throws after the
 * stock movement has committed (§3.3).
 */

function serviceWith(opts: {
  book?: { id: string } | null;
  moduleEnabled?: boolean;
  taggedAccounts?: readonly (string | null)[];
}) {
  const rows = (opts.taggedAccounts ?? []).map((systemTag) => ({ systemTag }));

  const chain: Record<string, unknown> = {};
  chain["from"] = () => chain;
  chain["where"] = () => Promise.resolve(rows);
  const db = { select: () => chain } as never;

  const books = { findDefault: async () => opts.book ?? null } as never;
  const access = { isModuleEnabled: async () => opts.moduleEnabled ?? false } as never;
  const stub = {} as never;

  return new AccountingSetupService(db, books, stub, stub, stub, access);
}

/** Every role the bridge names, so a book can be fully provisioned in a test. */
const ALL_ROLES = [...INVENTORY_SEAM_ROLES];

describe("accounting provisioning", () => {
  it("says nothing about an org that never asked for accounting", async () => {
    const service = serviceWith({ book: null, moduleEnabled: false });
    expect(await service.provisioning("org-1")).toEqual({ state: "not_requested" });
  });

  it("names the void an org posts into when the module is on and no book exists", async () => {
    const service = serviceWith({ book: null, moduleEnabled: true });
    const verdict = await service.provisioning("org-1");

    expect(verdict.state).toBe("unprovisioned");
    /* The distinction the catch site cannot draw: recorded nowhere, not opted out. */
    expect(verdict.state === "unprovisioned" && verdict.message).toMatch(/recorded nowhere/);
    expect(verdict.state === "unprovisioned" && verdict.message).toMatch(/Run accounting setup/);
  });

  it("does not ask about entitlement once a book exists", async () => {
    /*
      An org that created a book has settled the question. Asking anyway would
      put an entitlement round trip on the common path for no answer — and would
      make a book unreachable if its module row were ever flipped off, which is
      not a state the ledger should honour.
    */
    let asked = 0;
    const chain: Record<string, unknown> = {};
    chain["from"] = () => chain;
    chain["where"] = () => Promise.resolve(ALL_ROLES.map((systemTag) => ({ systemTag })));
    const service = new AccountingSetupService(
      { select: () => chain } as never,
      { findDefault: async () => ({ id: "book-1" }) } as never,
      {} as never,
      {} as never,
      {} as never,
      {
        isModuleEnabled: async () => {
          asked += 1;
          return false;
        },
      } as never,
    );

    expect(await service.provisioning("org-1")).toEqual({ state: "ready", bookId: "book-1" });
    expect(asked).toBe(0);
  });

  it("lists exactly the roles the inventory bridge cannot resolve", async () => {
    /* A chart with the sales side tagged and the stock side not. */
    const service = serviceWith({
      book: { id: "book-1" },
      taggedAccounts: ["ar_control", "sales", "cogs"],
    });
    const verdict = await service.provisioning("org-1");

    expect(verdict.state).toBe("incomplete");
    expect(verdict.state === "incomplete" && verdict.missingRoles).toEqual([
      "inventory",
      "ap_control",
    ]);
  });

  it("says what a missing role costs, not merely that one is missing", async () => {
    /*
      The difference between a setup nag and an actionable one. "Some roles are
      unmapped" is true and tells nobody that the consequence is a goods receipt
      that will not go through.
    */
    const service = serviceWith({ book: { id: "book-1" }, taggedAccounts: [] });
    const verdict = await service.provisioning("org-1");
    expect(verdict.state === "incomplete" && verdict.message).toMatch(
      /refused outright — the goods receipt or shipment does not happen/,
    );
  });

  it("ignores an untagged account rather than counting it as a role", async () => {
    /*
      `system_tag` is nullable and most accounts in a real chart carry none.
      A `Set` built without filtering would hold `null`, which is harmless here
      but would quietly become a bug the moment a role were ever named null.
    */
    const service = serviceWith({
      book: { id: "book-1" },
      taggedAccounts: [null, null, ...ALL_ROLES],
    });
    expect(await service.provisioning("org-1")).toEqual({ state: "ready", bookId: "book-1" });
  });

  it("refuses, with the same sentence, when a caller must not proceed", async () => {
    const unprovisioned = serviceWith({ book: null, moduleEnabled: true });
    await expect(unprovisioned.requireProvisioned("org-1")).rejects.toThrow(ConflictException);
    await expect(unprovisioned.requireProvisioned("org-1")).rejects.toThrow(/recorded nowhere/);

    const incomplete = serviceWith({ book: { id: "book-1" }, taggedAccounts: ["sales"] });
    await expect(incomplete.requireProvisioned("org-1")).rejects.toThrow(/"inventory"/);
  });

  it("lets an opted-out org through, because opting out is not a fault", async () => {
    /*
      The one that must NOT throw. `requireProvisioned` guarding a shared code
      path would otherwise break every accounting-disabled tenant — the exact
      regression ACC-16 exists to catch.
    */
    const optedOut = serviceWith({ book: null, moduleEnabled: false });
    await expect(optedOut.requireProvisioned("org-1")).resolves.toBeUndefined();
  });
});
