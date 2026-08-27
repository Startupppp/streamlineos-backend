import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALL_PARTY_CONSENT_JURISDICTIONS,
  determineJurisdiction,
  regimeFor,
  UNDETERMINED_JURISDICTION,
} from "../jurisdiction";

describe("determineJurisdiction — where the call happened", () => {
  it("places the call where the customer was, not where the office is", () => {
    // A Berlin customer rung from a London office is a German call. Reading it
    // the other way round is the mistake ticket 03 exists to prevent.
    expect(
      determineJurisdiction({ counterpartyNumber: "+4930123456", organisationCountry: "GB" }),
    ).toEqual({ jurisdiction: "DE", basis: "counterparty-number", regime: "all-party" });
  });

  it("prefers the longer calling code, so a Portuguese number is not French", () => {
    expect(
      determineJurisdiction({ counterpartyNumber: "+351912345678", organisationCountry: null })
        .jurisdiction,
    ).toBe("PT");
  });

  it("treats +1 as all-party, because it cannot be resolved past the United States", () => {
    /**
     * `+1` is the United States, Canada and twenty Caribbean territories on one
     * calling code. Canada is one-party and several US states are not, and no
     * amount of prefix matching separates them — so the code resolves to the
     * plan and the plan takes the stricter rule.
     */
    expect(
      determineJurisdiction({ counterpartyNumber: "+14155551212", organisationCountry: null }),
    ).toMatchObject({ jurisdiction: "NANP", regime: "all-party" });
  });

  it("falls back to the organisation's country only when nothing placed the customer", () => {
    expect(
      determineJurisdiction({ counterpartyNumber: null, organisationCountry: "in" }),
    ).toEqual({ jurisdiction: "IN", basis: "organisation-country", regime: "one-party" });
  });

  it("does not let a number with no country code fall through to the office's country", () => {
    /**
     * The one inference that is wrong in exactly the cases that matter: "we do
     * not know where they were" must not quietly become "they were where we are".
     * A bare national number is undetermined, which is all-party.
     */
    expect(
      determineJurisdiction({ counterpartyNumber: "4155551212", organisationCountry: "IN" }),
    ).toMatchObject({ basis: "undetermined", regime: "all-party" });
  });

  it("refuses a country nobody typed as a code, rather than reading it as one-party", () => {
    /**
     * `organizations.country` is free text. "India" is not in the all-party set,
     * so accepting it verbatim would hand every organisation with a spelled-out
     * country the LOOSER rule — which is the failure this whole file is designed
     * around.
     */
    expect(
      determineJurisdiction({ counterpartyNumber: null, organisationCountry: "India" }),
    ).toMatchObject({ jurisdiction: UNDETERMINED_JURISDICTION, regime: "all-party" });
  });

  it("resolves an unplaceable call to the stricter regime", () => {
    expect(
      determineJurisdiction({ counterpartyNumber: null, organisationCountry: null }).regime,
    ).toBe("all-party");
  });
});

describe("the regime is enforcement, not configuration", () => {
  const moduleDir = join(__dirname, "..");

  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? sourceFiles(join(dir, entry.name))
        : entry.name.endsWith(".ts") && !entry.name.endsWith(".spec.ts")
          ? [join(dir, entry.name)]
          : [],
    );

  it("keeps the jurisdiction table as a frozen module constant", () => {
    // Not a table, not a settings row, not a function argument. If this list ever
    // takes a tenant into account, the whole file stops being a legal constraint.
    expect(ALL_PARTY_CONSENT_JURISDICTIONS).toContain("DE");
    expect(ALL_PARTY_CONSENT_JURISDICTIONS).toContain("US");
    expect(regimeFor(UNDETERMINED_JURISDICTION)).toBe("all-party");
  });

  it("has no writable surface anywhere in the module", () => {
    /**
     * The way a rule like this dies is that somebody adds an override "just for
     * one customer". There is nothing to override: no route in this module
     * mutates anything, so there is no endpoint through which a tenant could
     * express an exception. Checked against the source rather than asserted in a
     * comment, because a comment is not a test.
     */
    const mutatingRoutes = sourceFiles(moduleDir).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return /@(Post|Put|Patch|Delete)\(/.test(source) ? [file] : [];
    });

    expect(mutatingRoutes).toEqual([]);
  });

  it("stores no per-tenant consent override on the analysis table", () => {
    /**
     * The second place an exception would have to live. `crm_call_analyses` has
     * columns that RECORD the regime and no column that could relax it — and the
     * migration's CHECK makes the unlawful row unrepresentable regardless of what
     * any future writer believes.
     */
    const migration = readFileSync(
      join(__dirname, "../../../../migrations/0533_call_analysis.sql"),
      "utf8",
    );

    expect(migration).not.toMatch(/consent_override|jurisdiction_override|recording_allowed/);
    expect(migration).toContain("chk_crm_call_analyses_consent_honoured");
  });
});
