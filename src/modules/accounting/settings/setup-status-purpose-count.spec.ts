import { readFileSync } from "node:fs";
import { join } from "node:path";
import { systemAccountPurposeSchema } from "./dto/settings.schemas";

/**
 * INV-09 — the setup checklist counts the list it is checking.
 *
 * `fetchSetupStatus` held `const TOTAL_PURPOSES = 16` and compared the number of
 * rows in `acc_system_account_map` against it. There were eighteen purposes when
 * that number was written and there are twenty-four now, so "Map system
 * accounts" reported itself **done** while eight purposes — including all six
 * inventory ones INV-09 added — were unmapped.
 *
 * That mattered here specifically. The one screen an admin would look at to ask
 * "have I configured my accounts?" answered yes for an organisation whose
 * inventory postings were all still falling back to defaults.
 *
 * Read as source rather than exercised through the service, because the service
 * needs a database, a cache and an audit sink to answer at all, and the property
 * is about a literal.
 */
describe("accounting setup status", () => {
  const source = readFileSync(join(__dirname, "accounting-settings.service.ts"), "utf8");

  it("has not lost the vocabulary it is counting", () => {
    // Anti-vacuity: both assertions below are about this list's length, so an
    // empty options tuple would make them pass while checking nothing.
    expect(systemAccountPurposeSchema.options.length).toBeGreaterThanOrEqual(24);
  });

  it("takes the purpose count from the schema, not from a literal", () => {
    expect(source).toContain(
      "const TOTAL_PURPOSES = systemAccountPurposeSchema.options.length;",
    );
  });

  it("holds no hand-written purpose total at all", () => {
    // The failure mode is not "the number is 16", it is "there is a number".
    // Any literal here drifts silently the next time a purpose is added, which
    // is exactly how this one reached 16 against a list of 24.
    expect(source).not.toMatch(/TOTAL_PURPOSES\s*=\s*\d+/);
  });
});
