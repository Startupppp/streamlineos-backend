import { onboardEmployeeSchema } from "../directory/dto/hr-directory.schemas";
import { resolvePersonDisplayName } from "../../../common/organization/person-display-name";
import {
  EMPLOYEE_EXPORT_CSV_HEADER,
  serializeEmployeeExportRow,
} from "./hr-export-csv";

/**
 * Ticket 07, the onboarding -> directory -> export walk.
 *
 * Onboarding parses the two name parts, the account name the directory displays
 * is composed from them by one shared policy, and the CSV carries the composed
 * name and the two parts in their own columns. Each hop used to normalise, or
 * not normalise, on its own: whitespace survived into every screen, and the
 * export was the one surface where first and last could not be told apart.
 */
const ONBOARDING_BASE = {
  email: "qa-emp@example.com",
  designation: "QA Senior Test Engineer",
  topLevelRole: true,
  topLevelRoleReason: "Founder, no reporting manager",
};

function onboardThenExport(firstName: string, lastName: string) {
  const onboarded = onboardEmployeeSchema.parse({
    ...ONBOARDING_BASE,
    firstName,
    lastName,
  });
  const accountName =
    resolvePersonDisplayName({
      firstName: onboarded.firstName,
      lastName: onboarded.lastName,
      email: onboarded.email,
    }) ?? onboarded.email;

  return {
    onboarded,
    accountName,
    csv: serializeEmployeeExportRow({
      name: accountName,
      firstName: onboarded.firstName,
      lastName: onboarded.lastName,
      email: onboarded.email,
      employeeId: "EMP-1",
      designation: onboarded.designation,
      role: "MEMBER",
      department: "R&D",
      status: "Active",
    }),
  };
}

describe("an employee's name from onboarding through the directory to the export", () => {
  it("normalises whitespace once, at onboarding, so no surface renders a double space", () => {
    const { onboarded, accountName, csv } = onboardThenExport("  Ada  ", " Byron   Lovelace ");

    expect(onboarded.firstName).toBe("Ada");
    expect(onboarded.lastName).toBe("Byron Lovelace");
    expect(accountName).toBe("Ada Byron Lovelace");
    expect(csv).toContain('"Ada Byron Lovelace","Ada","Byron Lovelace"');
  });

  it.each([
    ["QA", "Employee Test"],
    ["McDonald", "O'Brien"],
    ["van der Berg", "de Souza-Silva"],
    ["RAJENDRAN", "Iyer"],
  ])("carries %s %s through every hop exactly as typed", (firstName, lastName) => {
    const { onboarded, accountName, csv } = onboardThenExport(firstName, lastName);

    expect(onboarded.firstName).toBe(firstName);
    expect(onboarded.lastName).toBe(lastName);
    expect(accountName).toBe(`${firstName} ${lastName}`);
    expect(csv).toContain(`"${firstName}","${lastName}"`);
  });

  it("keeps the two parts separate in the file, in the columns the header declares", () => {
    const nameColumns = EMPLOYEE_EXPORT_CSV_HEADER.slice(0, 3);
    expect(nameColumns).toEqual(["Name", "First name", "Last name"]);

    const { csv } = onboardThenExport("van der Berg", "de Souza-Silva");
    const [name, first, last] = csv.split('","');
    expect(name).toBe('"van der Berg de Souza-Silva');
    expect(first).toBe("van der Berg");
    expect(last).toBe("de Souza-Silva");
  });
});
