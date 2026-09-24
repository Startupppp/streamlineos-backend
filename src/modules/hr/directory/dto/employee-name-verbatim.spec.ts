import { onboardEmployeeSchema } from "./hr-directory.schemas";
import { toTitleCase } from "../org-chart-helpers";

/**
 * HRMS-E2E-020. QA onboarded "QA Employee Test" and saw "Qa Employee Test"
 * everywhere — detail, directory, org chart and the CSV export. Lower-casing a
 * word and then capitalising its first letter is what turns QA into Qa, so the
 * ticket is asking for a title-caser to be taken off the name path.
 *
 * Traced through current main, there is none. The onboarding schema trims and
 * nothing else; `PersonEmploymentSyncService` and the bulk writer pass
 * `firstName`/`lastName` through unchanged; the org chart returns `name: row.name`
 * verbatim; and the employee export serialises `row.name` with no transform. The
 * one `toTitleCase` in the repository is applied to the membership *role* —
 * ORG_ADMIN becomes "Org Admin" — which is what it is for.
 *
 * So this suite does not fix a live defect; it pins the property the ticket
 * cares about, at the boundary where a normaliser would most plausibly be added
 * and where it would silently rewrite every name in the organisation. It fails
 * the moment one appears.
 */
describe("employee names are stored as entered", () => {
  const base = {
    email: "qa-emp@example.com",
    firstName: "QA",
    lastName: "Employee Test",
    designation: "QA Senior Test Engineer",
    topLevelRole: true,
    topLevelRoleReason: "Founder, no reporting manager",
  };

  it("keeps an all-caps first name intact", () => {
    const parsed = onboardEmployeeSchema.parse(base);
    expect(parsed.firstName).toBe("QA");
    expect(parsed.lastName).toBe("Employee Test");
  });

  it.each([
    ["QA", "an initialism"],
    ["McDonald", "an internal capital"],
    ["van der Berg", "a lowercase particle"],
    ["O'Brien", "an apostrophe"],
    ["de Souza-Silva", "a hyphen and a particle"],
    ["RAJENDRAN", "a name written in full caps"],
  ])("keeps %s (%s) exactly as typed", (name) => {
    expect(onboardEmployeeSchema.parse({ ...base, firstName: name }).firstName).toBe(name);
  });

  it("trims surrounding whitespace and nothing else", () => {
    expect(onboardEmployeeSchema.parse({ ...base, firstName: "  QA  " }).firstName).toBe("QA");
  });

  it("would have caught the reported symptom, had a title-caser been on this path", () => {
    // The transform the ticket describes, shown for what it does to a name. It
    // is applied to the membership role and must never reach firstName/lastName.
    expect(toTitleCase("QA Employee Test")).toBe("Qa Employee Test");
    expect(onboardEmployeeSchema.parse(base).firstName).not.toBe(toTitleCase(base.firstName));
  });

  it("title-cases a role, which is the only thing that helper is for", () => {
    expect(toTitleCase("ORG_ADMIN")).toBe("Org Admin");
  });
});
