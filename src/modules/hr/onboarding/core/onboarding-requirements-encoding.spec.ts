import { AMERICAS_ONBOARDING_REQUIREMENTS } from "./onboarding-requirements-americas.catalog";
import { APAC_ONBOARDING_REQUIREMENTS } from "./onboarding-requirements-apac.catalog";
import { EMEA_ONBOARDING_REQUIREMENTS } from "./onboarding-requirements-emea.catalog";

/**
 * HRMS-E2E-030. The PAN helper on the employee-onboarding bank step read
 * "Permanent Account Number â€" required for payroll and tax."
 *
 * The frontend renders that string; it does not write it. The bytes on disk here
 * were `c3a2 e282 ac e2809d` — U+00E2 U+20AC U+201D — which is a UTF-8 em-dash
 * (`e2 80 94`) that was decoded as cp1252 and encoded to UTF-8 a second time.
 * Mojibake that survives a round trip is indistinguishable from intended text to
 * every check in this repo, so nothing caught it.
 *
 * These catalogs are the copy an employee reads while handing over their PAN and
 * bank details, in the one place the product asks for the most sensitive fields
 * it holds. A sweep is used rather than a pin on one sentence because the defect
 * is a property of how the file was saved, not of that sentence.
 */

/** The three sequences cp1252 double-encoding produces for the punctuation this copy uses. */
const DOUBLE_ENCODED = [
  "â€”", // em dash —
  "â€™", // right single quote ’
  "â€œ", // left double quote “
  "Ã©", // é
  "ï¿½", // replacement character
];

function stringsOf(value: unknown, path: string): { path: string; text: string }[] {
  if (typeof value === "string") return [{ path, text: value }];
  if (Array.isArray(value))
    return value.flatMap((item, i) => stringsOf(item, `${path}[${i}]`));
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([key, item]) => stringsOf(item, `${path}.${key}`));
  return [];
}

const CATALOGS = {
  APAC: APAC_ONBOARDING_REQUIREMENTS,
  EMEA: EMEA_ONBOARDING_REQUIREMENTS,
  AMERICAS: AMERICAS_ONBOARDING_REQUIREMENTS,
};

describe("onboarding requirement copy is readable UTF-8", () => {
  it.each(Object.entries(CATALOGS))(
    "%s carries no double-encoded punctuation",
    (region, catalog) => {
      const damaged = stringsOf(catalog, region).filter(({ text }) =>
        DOUBLE_ENCODED.some((sequence) => text.includes(sequence)),
      );
      expect(damaged).toEqual([]);
    },
  );

  it("says what the PAN field is for, with a dash a person can read", () => {
    // The paired positive: a sweep for absence passes on an empty catalog, so
    // this asserts the sentence QA reported is present and intact.
    const india = APAC_ONBOARDING_REQUIREMENTS.IN;
    const pan = india?.statutoryFields.find((field) => field.key === "pan");

    expect(pan?.help).toBe("Permanent Account Number — required for payroll and tax.");
  });
});
