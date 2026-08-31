import { PgDialect, alias } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { hrEmployments, hrPeople, hrReportingLines, users } from "../../db/schema";
import {
  currentPrimaryReportingLine,
  liveEmployment,
  livePerson,
  livePersonOfEmployment,
  livePersonOfUser,
  managerEmploymentOfLine,
  orgUnitInOrg,
  primaryEmploymentOfPerson,
  reportingLineOfEmployment,
} from "./employment-query";

const ORG = "11111111-1111-4111-8111-111111111111";
const dialect = new PgDialect();
const render = (condition: SQL): string => dialect.sqlToQuery(condition).sql;

describe("employment query fragments", () => {
  describe("tenant scope", () => {
    const fragments: ReadonlyArray<[string, SQL]> = [
      ["livePersonOfUser", livePersonOfUser(ORG, users.id)],
      ["livePerson", livePerson(ORG)],
      ["primaryEmploymentOfPerson", primaryEmploymentOfPerson(ORG)],
      ["livePersonOfEmployment", livePersonOfEmployment(ORG)],
      ["liveEmployment", liveEmployment(ORG)],
      ["currentPrimaryReportingLine", currentPrimaryReportingLine(ORG)],
      ["reportingLineOfEmployment", reportingLineOfEmployment(ORG)],
      [
        "managerEmploymentOfLine",
        managerEmploymentOfLine(
          ORG,
          hrReportingLines,
          alias(hrEmployments, "mgr_employment"),
        ),
      ],
      ["orgUnitInOrg", orgUnitInOrg(ORG, hrEmployments.departmentId)],
    ];

    it.each(fragments)("%s carries an org_id predicate", (_name, condition) => {
      expect(render(condition)).toContain('"org_id" = $');
    });
  });

  describe("soft delete", () => {
    it("excludes a deleted person when resolving by user", () => {
      expect(render(livePersonOfUser(ORG, users.id))).toContain(
        '"hr_people"."deleted_at" is null',
      );
    });

    it("excludes a deleted person when resolving from an employment", () => {
      expect(render(livePersonOfEmployment(ORG))).toContain(
        '"hr_people"."deleted_at" is null',
      );
    });

    it("excludes a deleted employment", () => {
      expect(render(primaryEmploymentOfPerson(ORG))).toContain(
        '"hr_employments"."deleted_at" is null',
      );
      expect(render(liveEmployment(ORG))).toContain(
        '"hr_employments"."deleted_at" is null',
      );
    });

    it("excludes a deleted manager, which a hand-written join has repeatedly forgotten", () => {
      const managerEmployments = alias(hrEmployments, "mgr_employment");
      expect(
        render(managerEmploymentOfLine(ORG, hrReportingLines, managerEmployments)),
      ).toContain('"mgr_employment"."deleted_at" is null');
    });
  });

  describe("primary employment", () => {
    it("selects only the primary employment", () => {
      expect(render(primaryEmploymentOfPerson(ORG))).toContain('"is_primary" = $');
    });
  });

  describe("effective dating", () => {
    it("bounds the reporting line on both sides", () => {
      const rendered = render(currentPrimaryReportingLine(ORG));
      expect(rendered).toContain('"effective_from" <= CURRENT_DATE');
      expect(rendered).toContain('"effective_to" >= CURRENT_DATE');
    });

    it("does not match a line by the infinity sentinel alone", () => {
      expect(render(currentPrimaryReportingLine(ORG))).not.toContain("infinity");
    });

    it("restricts the line to its employment", () => {
      expect(render(reportingLineOfEmployment(ORG))).toContain('"employment_id" =');
    });
  });

  describe("aliasing", () => {
    it("applies every rule to an aliased people table", () => {
      const managerPeople = alias(hrPeople, "mgr_person");
      const rendered = render(livePersonOfUser(ORG, users.id, managerPeople));
      expect(rendered).toContain('"mgr_person"."org_id" = $');
      expect(rendered).toContain('"mgr_person"."deleted_at" is null');
    });
  });
});
