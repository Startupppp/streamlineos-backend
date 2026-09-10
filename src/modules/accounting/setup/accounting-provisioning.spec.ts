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

/**
 * A fiscal year far enough out that the ACC-17 cliff warning stays quiet, so
 * the tests about roles are testing roles.
 */
const FAR_FUTURE_YEAR = [{ name: "2026-27", startsOn: "2026-04-01", endsOn: "2027-03-31" }];
const TODAY = "2026-09-10";

function serviceWith(opts: {
  book?: { id: string } | null;
  moduleEnabled?: boolean;
  taggedAccounts?: readonly (string | null)[];
  fiscalYears?: Array<{ name: string; startsOn: string; endsOn: string }>;
  today?: string;
}) {
  const rows = (opts.taggedAccounts ?? []).map((systemTag) => ({ systemTag }));

  const chain: Record<string, unknown> = {};
  chain["from"] = () => chain;
  chain["where"] = () => Promise.resolve(rows);
  const db = { select: () => chain } as never;

  const books = { findDefault: async () => opts.book ?? null } as never;
  const access = { isModuleEnabled: async () => opts.moduleEnabled ?? false } as never;
  const periods = {
    listFiscalYears: async () => opts.fiscalYears ?? FAR_FUTURE_YEAR,
  } as never;
  const stub = {} as never;

  /* `today` is a protected seam so the cliff can be tested without a clock. */
  class Pinned extends AccountingSetupService {
    protected override today(): string {
      return opts.today ?? TODAY;
    }
  }
  return new Pinned(db, books, stub, stub, stub, access, periods);
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
      { listFiscalYears: async () => FAR_FUTURE_YEAR } as never,
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
    /*
      ACC-21 made this list longer, and that is the point of it: a vendor return
      resolves `grni`, a scrap `inventory_write_off`, and adjustments, counts
      and transfer shrinkage `inventory_adjustment`. Each is now a movement
      this book would refuse, so each belongs in the warning a tenant sees
      before they hit it.
    */
    expect(verdict.state === "incomplete" && verdict.missingRoles).toEqual([
      "inventory",
      "ap_control",
      "grni",
      "inventory_write_off",
      "inventory_adjustment",
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

  it("warns a month before the last fiscal year runs out", async () => {
    /*
      ACC-17. `LedgerService.resolvePeriod` refuses a journal whose date no
      period covers, and nothing opens the next fiscal year on a schedule. So on
      1 April — the India pack's year start — every posting on an organisation
      whose next year was never opened is refused, and the only warning today is
      the failure itself.
    */
    const service = serviceWith({
      book: { id: "book-1" },
      taggedAccounts: [...ALL_ROLES],
      fiscalYears: [{ name: "2025-26", startsOn: "2025-04-01", endsOn: "2026-03-31" }],
      today: "2026-03-10",
    });
    const verdict = await service.provisioning("org-1");

    expect(verdict.state).toBe("fiscal_year_ending");
    expect(verdict.state === "fiscal_year_ending" && verdict.daysRemaining).toBe(21);
    expect(verdict.state === "fiscal_year_ending" && verdict.message).toMatch(
      /Nothing opens the next one automatically/,
    );
    /* Names what stops, because "open the next fiscal year" alone reads optional. */
    expect(verdict.state === "fiscal_year_ending" && verdict.message).toMatch(
      /invoice, goods receipt, shipment and payroll run will be refused/,
    );
  });

  it("stays quiet while there is still a year of runway", async () => {
    const service = serviceWith({
      book: { id: "book-1" },
      taggedAccounts: [...ALL_ROLES],
      fiscalYears: [{ name: "2026-27", startsOn: "2026-04-01", endsOn: "2027-03-31" }],
      today: "2026-09-10",
    });
    expect(await service.provisioning("org-1")).toEqual({ state: "ready", bookId: "book-1" });
  });

  it("keeps warning after the cliff, rather than falling silent past it", async () => {
    /*
      The day after is when it matters most. A `daysRemaining > 0` guard would
      make the warning disappear at exactly the moment every posting starts
      failing, leaving the settings page reporting `ready` on a book that can
      accept nothing.
    */
    const service = serviceWith({
      book: { id: "book-1" },
      taggedAccounts: [...ALL_ROLES],
      fiscalYears: [{ name: "2025-26", startsOn: "2025-04-01", endsOn: "2026-03-31" }],
      today: "2026-04-02",
    });
    const verdict = await service.provisioning("org-1");

    expect(verdict.state).toBe("fiscal_year_ending");
    expect(verdict.state === "fiscal_year_ending" && verdict.daysRemaining).toBe(-2);
  });

  it("reads the furthest year end, not the most recently opened", async () => {
    /*
      A backdated prior year opened after the current one would otherwise report
      a cliff that passed years ago. The question is "how far forward can this
      book post", and only the furthest end answers it.
    */
    const service = serviceWith({
      book: { id: "book-1" },
      taggedAccounts: [...ALL_ROLES],
      fiscalYears: [
        { name: "2026-27", startsOn: "2026-04-01", endsOn: "2027-03-31" },
        { name: "2024-25", startsOn: "2024-04-01", endsOn: "2025-03-31" },
      ],
      today: "2026-09-10",
    });
    expect((await service.provisioning("org-1")).state).toBe("ready");
  });

  it("counts days on UTC midnights, not through the host's clock", async () => {
    /*
      A fiscal year ends on a DATE. Parsing it through a local timezone would
      move the boundary by a day for half the world, and this repo has already
      had a leave persisted a day early for exactly that reason.
    */
    const service = serviceWith({
      book: { id: "book-1" },
      taggedAccounts: [...ALL_ROLES],
      fiscalYears: [{ name: "2025-26", startsOn: "2025-04-01", endsOn: "2026-03-31" }],
      today: "2026-03-31",
    });
    const verdict = await service.provisioning("org-1");
    expect(verdict.state === "fiscal_year_ending" && verdict.daysRemaining).toBe(0);
  });

  it("says nothing about a book with no fiscal year at all", async () => {
    /*
      That is a different fault and `enable` already refuses it. Reporting a
      cliff for a book that was never opened would send someone to the wrong
      screen.
    */
    const service = serviceWith({
      book: { id: "book-1" },
      taggedAccounts: [...ALL_ROLES],
      fiscalYears: [],
    });
    expect((await service.provisioning("org-1")).state).toBe("ready");
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
