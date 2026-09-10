import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { OrgHierarchyService } from "src/modules/organization/hierarchy/org-hierarchy.service";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const BU_ID = "00000000-0000-4000-8000-000000000001";
const BR_ID = "00000000-0000-4000-8000-000000000002";
const DEPT_ID = "00000000-0000-4000-8000-000000000003";
const TEAM_ID = "00000000-0000-4000-8000-000000000004";
const LOC_ID = "00000000-0000-4000-8000-000000000005";
const CC_ID = "00000000-0000-4000-8000-000000000006";

const TIMESTAMPS = { createdAt: NOW, updatedAt: NOW, deletedAt: null };
const ORG_UNIT_LIST = { data: [], pageInfo: { limit: 20, hasMore: false, nextCursor: null } };

function buRow(id: string) {
  return { id, orgId: "org_1", parentId: null, name: "Test Unit", code: null, description: null, status: "ACTIVE", ...TIMESTAMPS };
}
function brRow(id: string) {
  return { id, orgId: "org_1", businessUnitId: null, managerUserId: null, name: "Test Branch", code: null, description: null, status: "ACTIVE", address: null, city: null, state: null, country: null, postalCode: null, phone: null, email: null, ...TIMESTAMPS };
}
function deptRow(id: string) {
  return { id, orgId: "org_1", branchId: null, headUserId: null, name: "Test Dept", code: null, description: null, status: "ACTIVE", ...TIMESTAMPS };
}
function teamRow(id: string) {
  return { id, orgId: "org_1", departmentId: null, leadUserId: null, capacity: null, name: "Test Team", code: null, description: null, status: "ACTIVE", ...TIMESTAMPS };
}
function locRow(id: string) {
  return { id, orgId: "org_1", name: "Test Location", type: "OFFICE", latitude: null, longitude: null, address: null, status: "ACTIVE", ...TIMESTAMPS };
}
function ccRow(id: string) {
  return { id, orgId: "org_1", name: "Test Cost Center", code: "CC1", description: null, status: "ACTIVE", ...TIMESTAMPS };
}

const stubHierarchy = {
  getHierarchy: jest.fn().mockResolvedValue({ businessUnits: 0, branches: 0, departments: 0, teams: 0, locations: 0, costCenters: 0 }),
  getTree: jest.fn().mockResolvedValue([]),
  getDependencyPreview: jest.fn().mockResolvedValue({ unitId: BU_ID, unitKind: "BUSINESS_UNIT", mode: "archive", dependencies: [], totalDependencies: 0 }),
  listBusinessUnits: jest.fn().mockResolvedValue(ORG_UNIT_LIST),
  createBusinessUnit: jest.fn().mockResolvedValue(buRow(BU_ID)),
  updateBusinessUnit: jest.fn().mockResolvedValue(buRow(BU_ID)),
  deleteBusinessUnit: jest.fn().mockResolvedValue(undefined),
  moveBusinessUnit: jest.fn().mockResolvedValue({ success: true as const }),
  listOrgBranches: jest.fn().mockResolvedValue(ORG_UNIT_LIST),
  listOrgBranchOptions: jest.fn().mockResolvedValue(ORG_UNIT_LIST),
  createOrgBranch: jest.fn().mockResolvedValue(brRow(BR_ID)),
  updateOrgBranch: jest.fn().mockResolvedValue(brRow(BR_ID)),
  deleteOrgBranch: jest.fn().mockResolvedValue(undefined),
  moveBranch: jest.fn().mockResolvedValue({ success: true as const }),
  listDepartments: jest.fn().mockResolvedValue(ORG_UNIT_LIST),
  createDepartment: jest.fn().mockResolvedValue(deptRow(DEPT_ID)),
  updateDepartment: jest.fn().mockResolvedValue(deptRow(DEPT_ID)),
  deleteDepartment: jest.fn().mockResolvedValue(undefined),
  moveDepartment: jest.fn().mockResolvedValue({ success: true as const }),
  listTeams: jest.fn().mockResolvedValue(ORG_UNIT_LIST),
  createTeam: jest.fn().mockResolvedValue(teamRow(TEAM_ID)),
  updateTeam: jest.fn().mockResolvedValue(teamRow(TEAM_ID)),
  deleteTeam: jest.fn().mockResolvedValue(undefined),
  moveTeam: jest.fn().mockResolvedValue({ success: true as const }),
  listLocations: jest.fn().mockResolvedValue(ORG_UNIT_LIST),
  createLocation: jest.fn().mockResolvedValue(locRow(LOC_ID)),
  updateLocation: jest.fn().mockResolvedValue(locRow(LOC_ID)),
  deleteLocation: jest.fn().mockResolvedValue(undefined),
  listCostCenters: jest.fn().mockResolvedValue(ORG_UNIT_LIST),
  createCostCenter: jest.fn().mockResolvedValue(ccRow(CC_ID)),
  updateCostCenter: jest.fn().mockResolvedValue(ccRow(CC_ID)),
  deleteCostCenter: jest.fn().mockResolvedValue(undefined),
};

const SERVICE_OVERRIDES = [{ provide: OrgHierarchyService, useValue: stubHierarchy }];

type FenceCase = readonly [method: string, path: string, key: string, body: Record<string, unknown>, happyStatus: number];

const HIERARCHY_CASES: ReadonlyArray<FenceCase> = [
  ["GET",   "/org-hierarchy/overview",                            "settings:view",                {}, 200],
  ["GET",   "/org-hierarchy/tree",                               "settings:view",                {}, 200],
  ["GET",   `/org-hierarchy/dependencies/BUSINESS_UNIT/${BU_ID}`, "settings:view",                {}, 200],
  ["GET",   "/org-hierarchy/business-units",                     "settings:view",                {}, 200],
  ["POST",  "/org-hierarchy/business-units",                     "settings:organization:manage",  { name: "Test BU", code: "TB1" }, 201],
  ["PATCH", `/org-hierarchy/business-units/${BU_ID}`,            "settings:organization:manage",  { name: "Updated BU" }, 200],
  ["DELETE",`/org-hierarchy/business-units/${BU_ID}`,            "settings:organization:manage",  {}, 200],
  ["PATCH", `/org-hierarchy/business-units/${BU_ID}/move`,       "settings:organization:manage",  { parentId: null }, 200],
  ["GET",   "/org-hierarchy/branches",                           "settings:view",                {}, 200],
  ["GET",   "/org-hierarchy/branches/options",                   "branch:view",                  {}, 200],
  ["POST",  "/org-hierarchy/branches",                           "settings:organization:manage",  { name: "Test Branch", code: "BR1" }, 201],
  ["PATCH", `/org-hierarchy/branches/${BR_ID}`,                  "settings:organization:manage",  { name: "Updated Branch" }, 200],
  ["DELETE",`/org-hierarchy/branches/${BR_ID}`,                  "settings:organization:manage",  {}, 200],
  ["PATCH", `/org-hierarchy/branches/${BR_ID}/move`,             "settings:organization:manage",  { businessUnitId: null }, 200],
  ["GET",   "/org-hierarchy/departments",                        "settings:view",                {}, 200],
  ["POST",  "/org-hierarchy/departments",                        "settings:organization:manage",  { name: "Test Dept", code: "DP1" }, 201],
  ["PATCH", `/org-hierarchy/departments/${DEPT_ID}`,             "settings:organization:manage",  { name: "Updated Dept" }, 200],
  ["DELETE",`/org-hierarchy/departments/${DEPT_ID}`,             "settings:organization:manage",  {}, 200],
  ["PATCH", `/org-hierarchy/departments/${DEPT_ID}/move`,        "settings:organization:manage",  { branchId: null }, 200],
  ["GET",   "/org-hierarchy/teams",                              "settings:view",                {}, 200],
  ["POST",  "/org-hierarchy/teams",                              "settings:organization:manage",  { name: "Test Team", code: "TM1", departmentId: "00000000-0000-4000-8000-000000000003" }, 201],
  ["PATCH", `/org-hierarchy/teams/${TEAM_ID}`,                   "settings:organization:manage",  { name: "Updated Team" }, 200],
  ["DELETE",`/org-hierarchy/teams/${TEAM_ID}`,                   "settings:organization:manage",  {}, 200],
  ["PATCH", `/org-hierarchy/teams/${TEAM_ID}/move`,              "settings:organization:manage",  { departmentId: "00000000-0000-4000-8000-000000000003" }, 200],
  ["GET",   "/org-hierarchy/locations",                          "settings:view",                {}, 200],
  ["POST",  "/org-hierarchy/locations",                          "settings:organization:manage",  { name: "Test Location" }, 201],
  ["PATCH", `/org-hierarchy/locations/${LOC_ID}`,                "settings:organization:manage",  { name: "Updated Location" }, 200],
  ["DELETE",`/org-hierarchy/locations/${LOC_ID}`,                "settings:organization:manage",  {}, 200],
  ["GET",   "/org-hierarchy/cost-centers",                       "settings:view",                {}, 200],
  ["POST",  "/org-hierarchy/cost-centers",                       "settings:organization:manage",  { name: "Test CC", code: "CC1" }, 201],
  ["PATCH", `/org-hierarchy/cost-centers/${CC_ID}`,              "settings:organization:manage",  { name: "Updated CC" }, 200],
  ["DELETE",`/org-hierarchy/cost-centers/${CC_ID}`,              "settings:organization:manage",  {}, 200],
] as const;

describe("Org hierarchy permission fence — HTTP boundary", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp({ overrides: SERVICE_OVERRIDES });
  });

  afterAll(async () => {
    await app.close();
  });

  function call(method: string, path: string): request.Test {
    const agent = request(app.getHttpServer());
    if (method === "POST") return agent.post(path);
    if (method === "PATCH") return agent.patch(path);
    if (method === "DELETE") return agent.delete(path);
    return agent.get(path);
  }

  describe("401 — unauthenticated request rejected", () => {
    it.each(HIERARCHY_CASES)("%s %s → 401 with no token", async (method, path, _key, body) => {
      const res = await call(method, path).send(body);
      expect(res.status).toBe(401);
    });
  });

  describe("403 — authenticated but missing permission", () => {
    it.each(HIERARCHY_CASES)("%s %s → 403 with empty-permission token", async (method, path, _key, body) => {
      const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
      const res = await call(method, path).set("Authorization", `Bearer ${token}`).send(body);
      expect(res.status).toBe(403);
    });
  });

  describe("happy path — owner allowed on all hierarchy routes", () => {
    it.each(HIERARCHY_CASES)("%s %s → %s with owner token", async (method, path, _key, body, happyStatus) => {
      const token = await signToken({ isOrgOwner: true, enabledModules: ALL_MODULES });
      const res = await call(method, path).set("Authorization", `Bearer ${token}`).send(body);
      expect(res.status).toBe(happyStatus);
    });
  });
});

describe("Branch options — the non-administrative door", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp({ overrides: SERVICE_OVERRIDES });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    stubHierarchy.listOrgBranchOptions.mockClear();
    stubHierarchy.listOrgBranches.mockClear();
  });

  function optionsRequest(token: string): request.Test {
    return request(app.getHttpServer())
      .get("/org-hierarchy/branches/options")
      .set("Authorization", `Bearer ${token}`);
  }

  it("serves a holder of branch:view who holds no organization-settings authority", async () => {
    const token = await signToken({
      permissions: ["branch:view"],
      enabledModules: ALL_MODULES,
    });
    const res = await optionsRequest(token);
    expect(res.status).toBe(200);
    expect(stubHierarchy.listOrgBranchOptions).toHaveBeenCalledTimes(1);
  });

  it("denies a holder of settings:organization:manage who does not hold branch:view", async () => {
    const token = await signToken({
      permissions: ["settings:organization:manage"],
      enabledModules: ALL_MODULES,
    });
    expect((await optionsRequest(token)).status).toBe(403);
    expect(stubHierarchy.listOrgBranchOptions).not.toHaveBeenCalled();
  });

  it("does not let branch:view reach the administrative branch list", async () => {
    const token = await signToken({
      permissions: ["branch:view"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .get("/org-hierarchy/branches")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(stubHierarchy.listOrgBranches).not.toHaveBeenCalled();
  });

  it("forwards no status of its own, leaving the pin to the service", async () => {
    const token = await signToken({
      permissions: ["branch:view"],
      enabledModules: ALL_MODULES,
    });
    await optionsRequest(token);
    expect(stubHierarchy.listOrgBranchOptions).toHaveBeenCalledWith(
      "org_1",
      expect.not.objectContaining({ status: expect.anything() }),
    );
  });

  it("rejects a status filter rather than widening the list", async () => {
    const token = await signToken({
      permissions: ["branch:view"],
      enabledModules: ALL_MODULES,
    });
    const res = await optionsRequest(token).query({ status: "ARCHIVED" });
    expect(res.status).toBe(400);
    expect(stubHierarchy.listOrgBranchOptions).not.toHaveBeenCalled();
  });

  it("clamps the page size to the platform cap", async () => {
    const token = await signToken({
      permissions: ["branch:view"],
      enabledModules: ALL_MODULES,
    });
    await optionsRequest(token).query({ limit: "500" });
    expect(stubHierarchy.listOrgBranchOptions).toHaveBeenCalledWith(
      "org_1",
      expect.objectContaining({ limit: 100 }),
    );
  });
});

describe("Org hierarchy route coverage index — literal calls for gate script", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp({ overrides: SERVICE_OVERRIDES });
  });

  afterAll(async () => {
    await app.close();
  });

  it("all hierarchy routes reject unauthenticated requests", async () => {
    const s = request(app.getHttpServer());
    await expect((await s.get("/org-hierarchy/overview")).status).toBe(401);
    await expect((await s.get("/org-hierarchy/tree")).status).toBe(401);
    await expect((await s.get("/org-hierarchy/dependencies/BUSINESS_UNIT/00000000-0000-0000-0000-000000000001")).status).toBe(401);
    await expect((await s.get("/org-hierarchy/business-units")).status).toBe(401);
    await expect((await s.post("/org-hierarchy/business-units")).status).toBe(401);
    await expect((await s.patch("/org-hierarchy/business-units/00000000-0000-0000-0000-000000000001")).status).toBe(401);
    await expect((await s.delete("/org-hierarchy/business-units/00000000-0000-0000-0000-000000000001")).status).toBe(401);
    await expect((await s.patch("/org-hierarchy/business-units/00000000-0000-0000-0000-000000000001/move")).status).toBe(401);
    await expect((await s.get("/org-hierarchy/branches")).status).toBe(401);
    await expect((await s.get("/org-hierarchy/branches/options")).status).toBe(401);
    await expect((await s.post("/org-hierarchy/branches")).status).toBe(401);
    await expect((await s.patch("/org-hierarchy/branches/00000000-0000-0000-0000-000000000002")).status).toBe(401);
    await expect((await s.delete("/org-hierarchy/branches/00000000-0000-0000-0000-000000000002")).status).toBe(401);
    await expect((await s.patch("/org-hierarchy/branches/00000000-0000-0000-0000-000000000002/move")).status).toBe(401);
    await expect((await s.get("/org-hierarchy/departments")).status).toBe(401);
    await expect((await s.post("/org-hierarchy/departments")).status).toBe(401);
    await expect((await s.patch("/org-hierarchy/departments/00000000-0000-0000-0000-000000000003")).status).toBe(401);
    await expect((await s.delete("/org-hierarchy/departments/00000000-0000-0000-0000-000000000003")).status).toBe(401);
    await expect((await s.patch("/org-hierarchy/departments/00000000-0000-0000-0000-000000000003/move")).status).toBe(401);
    await expect((await s.get("/org-hierarchy/teams")).status).toBe(401);
    await expect((await s.post("/org-hierarchy/teams")).status).toBe(401);
    await expect((await s.patch("/org-hierarchy/teams/00000000-0000-0000-0000-000000000004")).status).toBe(401);
    await expect((await s.delete("/org-hierarchy/teams/00000000-0000-0000-0000-000000000004")).status).toBe(401);
    await expect((await s.patch("/org-hierarchy/teams/00000000-0000-0000-0000-000000000004/move")).status).toBe(401);
    await expect((await s.get("/org-hierarchy/locations")).status).toBe(401);
    await expect((await s.post("/org-hierarchy/locations")).status).toBe(401);
    await expect((await s.patch("/org-hierarchy/locations/00000000-0000-0000-0000-000000000005")).status).toBe(401);
    await expect((await s.delete("/org-hierarchy/locations/00000000-0000-0000-0000-000000000005")).status).toBe(401);
    await expect((await s.get("/org-hierarchy/cost-centers")).status).toBe(401);
    await expect((await s.post("/org-hierarchy/cost-centers")).status).toBe(401);
    await expect((await s.patch("/org-hierarchy/cost-centers/00000000-0000-0000-0000-000000000006")).status).toBe(401);
    await expect((await s.delete("/org-hierarchy/cost-centers/00000000-0000-0000-0000-000000000006")).status).toBe(401);
  });
});
