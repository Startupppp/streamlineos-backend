import { makeFakeDb } from "../../../test/fake-select-db";
import type { Db } from "../../../db/drizzle.module";
import { orgUnits } from "../../../db/schema";
import { OrgHierarchyBranchesService } from "./org-hierarchy-branches.service";
import { OrgHierarchyDepartmentsService } from "./org-hierarchy-departments.service";
import { OrgHierarchyTeamsService } from "./org-hierarchy-teams.service";
import { OrgUnitCrudService } from "./org-unit-crud";

const ORG = "org-1";

const audit = () => ({ logCritical: jest.fn() });
const cache = () => ({ invalidateAfterMutation: jest.fn() });

function crud(db: Db) {
  return new OrgUnitCrudService(db, audit(), cache());
}

function unit(overrides: Record<string, unknown>) {
  return {
    id: "u",
    org_id: ORG,
    kind: "BRANCH",
    parent_id: null,
    name: "Unit",
    code: "U",
    description: null,
    head_membership_id: null,
    status: "ACTIVE",
    metadata: {},
    row_version: 1,
    archived_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    ...overrides,
  };
}

describe("organization hierarchy reads exclude archived and deleted rows", () => {
  it("listOrgBranches omits a soft-deleted branch", async () => {
    const db = makeFakeDb({
      org_units: [
        unit({ id: "live", name: "Live branch", code: "LIVE" }),
        unit({ id: "gone", name: "Retired branch", code: "GONE", deleted_at: new Date() }),
      ],
      head_member: [],
      branch_business_units: [],
    });
    const service = new OrgHierarchyBranchesService(crud(db as unknown as Db));

    const page = await service.listOrgBranches(ORG, { limit: 20 });

    expect(page.data.map((row) => row.id)).toEqual(["live"]);
  });

  it("listOrgBranches does not name a soft-deleted parent business unit", async () => {
    const db = makeFakeDb({
      org_units: [unit({ id: "b1", name: "Branch", code: "B1", parent_id: "bu1" })],
      head_member: [],
      branch_business_units: [
        unit({ id: "bu1", kind: "BUSINESS_UNIT", name: "Retired BU", code: "BU1", deleted_at: new Date() }),
      ],
    });
    const service = new OrgHierarchyBranchesService(crud(db as unknown as Db));

    const page = await service.listOrgBranches(ORG, { limit: 20 });

    expect(page.data).toHaveLength(1);
    expect(page.data[0]?.businessUnitName).toBeNull();
  });

  it("listDepartments does not name a soft-deleted parent branch", async () => {
    const db = makeFakeDb({
      org_units: [unit({ id: "d1", kind: "DEPARTMENT", name: "Dept", code: "D1", parent_id: "br1" })],
      head_member: [],
      department_branches: [
        unit({ id: "br1", kind: "BRANCH", name: "Retired branch", code: "BR1", deleted_at: new Date() }),
      ],
    });
    const service = new OrgHierarchyDepartmentsService(crud(db as unknown as Db));

    const page = await service.listDepartments(ORG, { limit: 20 });

    expect(page.data).toHaveLength(1);
    expect(page.data[0]?.branchName).toBeNull();
  });

  it("listTeams does not name a soft-deleted parent department", async () => {
    const db = makeFakeDb({
      org_units: [unit({ id: "t1", kind: "TEAM", name: "Team", code: "T1", parent_id: "dp1" })],
      head_member: [],
      team_departments: [
        unit({ id: "dp1", kind: "DEPARTMENT", name: "Retired dept", code: "DP1", deleted_at: new Date() }),
      ],
    });
    const service = new OrgHierarchyTeamsService(crud(db as unknown as Db));

    const page = await service.listTeams(ORG, { limit: 20 });

    expect(page.data).toHaveLength(1);
    expect(page.data[0]?.departmentName).toBeNull();
  });

  it("createTeam refuses an ARCHIVED department as the parent", async () => {
    const db = makeFakeDb(
      {
        org_units: [
          unit({ id: "dp1", kind: "DEPARTMENT", name: "Archived dept", code: "DP1", status: "ARCHIVED" }),
        ],
        head_member: [],
        team_departments: [],
      },
      { orgUnits },
    );
    const service = new OrgHierarchyTeamsService(crud(db as unknown as Db));

    await expect(
      service.createTeam(ORG, "user-1", { name: "Team", code: "T1", departmentId: "dp1" }),
    ).rejects.toThrow("Select an active department from this organization");
  });

  it("createTeam accepts an ACTIVE department as the parent", async () => {
    const db = makeFakeDb(
      {
        org_units: [
          unit({ id: "dp2", kind: "DEPARTMENT", name: "Live dept", code: "DP2" }),
        ],
        head_member: [],
        team_departments: [],
      },
      { orgUnits },
    );
    const service = new OrgHierarchyTeamsService(crud(db as unknown as Db));

    await expect(
      service.createTeam(ORG, "user-1", { name: "Team", code: "T2", departmentId: "dp2" }),
    ).resolves.toEqual(expect.objectContaining({ id: 1 }));
  });
});
