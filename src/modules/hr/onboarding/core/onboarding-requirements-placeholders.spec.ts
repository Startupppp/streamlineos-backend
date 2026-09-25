import { AMERICAS_ONBOARDING_REQUIREMENTS } from "./onboarding-requirements-americas.catalog";
import { APAC_ONBOARDING_REQUIREMENTS } from "./onboarding-requirements-apac.catalog";
import { EMEA_ONBOARDING_REQUIREMENTS } from "./onboarding-requirements-emea.catalog";
import type { CountryOnboardingRequirements } from "./onboarding-requirements.types";

/**
 * V-131. The wizard renders `field.placeholder` verbatim, and these placeholders
 * were realistic unprefixed values — `ABCDE1234F`, `HDFC0001234`, `021000021`
 * (a real US routing number), a full AE IBAN. In a greyed-out input they read
 * as data somebody had already filled in, and a person who believed that would
 * submit an empty bank record.
 *
 * A format example must say it is one. Prose placeholders ("Your bank's name")
 * carry no digits and are not examples of anything, so they are left alone.
 */
const CATALOGS: Array<[string, Record<string, CountryOnboardingRequirements>]> = [
  ["APAC", APAC_ONBOARDING_REQUIREMENTS],
  ["EMEA", EMEA_ONBOARDING_REQUIREMENTS],
  ["AMERICAS", AMERICAS_ONBOARDING_REQUIREMENTS],
];

function everyPlaceholder(): Array<{ where: string; placeholder: string }> {
  const out: Array<{ where: string; placeholder: string }> = [];
  for (const [region, catalog] of CATALOGS)
    for (const [countryCode, requirements] of Object.entries(catalog)) {
      for (const field of requirements.bankFields)
        out.push({
          where: `${region}/${countryCode} bank.${field.key}`,
          placeholder: field.placeholder,
        });
      for (const field of requirements.statutoryFields)
        out.push({
          where: `${region}/${countryCode} statutory.${field.key}`,
          placeholder: field.placeholder,
        });
    }
  return out;
}

describe("onboarding requirement placeholders", () => {
  it("every format-example placeholder is marked as an example, so a hint is never mistaken for a prefilled value", () => {
    const offenders = everyPlaceholder().filter(
      ({ placeholder }) => /\d/.test(placeholder) && !placeholder.startsWith("e.g. "),
    );

    expect(
      offenders.map(({ where, placeholder }) => `${where}: ${placeholder}`),
    ).toEqual([]);
  });

  it("covers every catalogued country, so a new one cannot slip the rule", () => {
    const entries = everyPlaceholder();
    expect(entries.length).toBeGreaterThan(20);
    expect(entries.every(({ placeholder }) => placeholder.trim().length > 0)).toBe(true);
  });
});
