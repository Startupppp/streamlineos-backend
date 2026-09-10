import { ConflictException } from "@nestjs/common";
import { AccountingSetupService } from "./accounting-setup.service";

/**
 * ACC-02's real failure mode: enabled, unprovisioned, and silent about it.
 *
 * `gl_book_currencies.currency_code` has an FK to `gl_currencies(code)`, and
 * `BooksService.enable` inserts the base-currency row with
 * `onConflictDoNothing()` -- which suppresses a UNIQUE conflict and CANNOT
 * suppress an FK violation. On a database where `gl_currencies` is empty, every
 * attempt to switch accounting on for any organisation dies with a raw 23503 out
 * of the driver and the operator is told nothing they can act on.
 *
 * Not hypothetical, and not test-only. Measured on the shared branch:
 * `gl_currencies` exists with the right six columns and holds ZERO rows, and
 * `gl_accounts` is empty beside it. `0464_gl_kernel` carries both the DDL and the
 * currency seed; `0489_chain_creates_early` and
 * `0619_chain_creates_what_production_has` transcribe a `pg_catalog`, so they
 * recreate the STRUCTURE and cannot recreate the DATA. A correctly-shaped empty
 * table is the hardest kind of missing to notice -- 220 accounting e2e tests fail
 * on this one cause and none of them says the word "currency".
 */

function serviceWith(rows: readonly { code: string }[][]) {
  let read = 0;
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "where"]) chain[method] = () => chain;
  chain["limit"] = () => Promise.resolve(rows[read++] ?? []);
  const db = { select: () => chain } as never;
  const stub = {} as never;
  return new AccountingSetupService(db, stub, stub, stub, stub);
}

/** `enable` is only reachable through the private guard, so drive it through `enable`. */
async function enable(service: AccountingSetupService, baseCurrency?: string) {
  return service.enable("org-1", "user-1", { baseCurrency } as never);
}

describe("enabling accounting on an unprovisioned database", () => {
  it("names the missing seed rather than letting the driver answer", async () => {
    const service = serviceWith([[]]);

    await expect(enable(service, "INR")).rejects.toThrow(ConflictException);
    await expect(enable(service, "INR")).rejects.toThrow(/gl_currencies is empty/);
    /* The actionable half: which migration to run, not which constraint fired. */
    await expect(enable(service, "INR")).rejects.toThrow(/0464_gl_kernel/);
  });

  it("checks emptiness even when the caller names no currency", async () => {
    /*
      An omitted `baseCurrency` is resolved to the pack default inside
      BooksService, so a guard that only checked a named code would let the
      commonest call -- the setup wizard's -- through to the same raw 23503.
    */
    const service = serviceWith([[]]);
    await expect(enable(service)).rejects.toThrow(/gl_currencies is empty/);
  });

  it("refuses a currency this deployment does not carry, separately", async () => {
    /* Reference data present, code unknown: a different sentence, not the same one. */
    const service = serviceWith([[{ code: "INR" }], []]);
    await expect(enable(service, "XYZ")).rejects.toThrow(/not one of the currencies/);
  });

  it("does not duplicate the pack's default-currency resolution", async () => {
    /*
      Reference data present and no code named: the guard must fall through
      rather than guess at the pack default and refuse something valid. It gets
      past the guard and fails later on the stubbed BooksService, which is the
      proof it got past.
    */
    const service = serviceWith([[{ code: "INR" }]]);
    await expect(enable(service)).rejects.not.toThrow(ConflictException);
  });
});
