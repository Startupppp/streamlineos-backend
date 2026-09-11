import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createE2eApp, accessStub } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { AccessService } from "src/modules/access/access.service";
import { RbacService } from "src/modules/rbac/rbac.service";
import { RolesService } from "src/modules/rbac/roles.service";
import { RoleSeedService } from "src/modules/rbac/role-seed.service";
import { RolesQueryService } from "src/modules/rbac/roles-query.service";
import { PrincipalGroupsService } from "src/modules/rbac/principal-groups.service";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const GROUP_UUID = "00000000-0000-0000-0000-000000000001";

const ROLE_ROW = {
  id: 1, name: "Test Role", slug: "test-role", rank: 10, orgId: "org_1",
  version: 1, isSystem: false, moduleKey: null, createdBy: null,
  createdAt: NOW, updatedAt: NOW, description: null,
};

const stubRbac = {
  getAllPermissions: jest.fn().mockResolvedValue([]),
  assignRolePermission: jest.fn().mockResolvedValue({ success: true as const }),
  revokeRolePermission: jest.fn().mockResolvedValue({ success: true as const }),
  getDiscoveryPermissions: jest.fn().mockResolvedValue([]),
  getDiscoveryGrantable: jest.fn().mockResolvedValue({ grantableKeys: [], assignableRanks: [], allowedModules: null }),
  getDiscoveryTemplates: jest.fn().mockResolvedValue([]),
  getDiscoveryMembers: jest.fn().mockResolvedValue([]),
};

const stubRoles = {
  getRoles: jest.fn().mockResolvedValue({ data: [], pagination: { limit: 20, hasMore: false, nextCursor: null } }),
  getRole: jest.fn().mockResolvedValue(ROLE_ROW),
  updateRole: jest.fn().mockResolvedValue({ success: true as const }),
  deleteRole: jest.fn().mockResolvedValue({ success: true as const }),
  getPermissionsMatrix: jest.fn().mockResolvedValue([]),
  getRolePermissions: jest.fn().mockResolvedValue([]),
  setRolePermissions: jest.fn().mockResolvedValue({ success: true as const, version: 2 }),
  getRoleMembers: jest.fn().mockResolvedValue([]),
  addRoleMember: jest.fn().mockResolvedValue({ success: true as const }),
  removeRoleMember: jest.fn().mockResolvedValue({ success: true as const }),
};

const stubSeed = {
  seedDefaultRoles: jest.fn().mockResolvedValue({ created: [], skipped: [] }),
  materializeTemplate: jest.fn().mockResolvedValue({ ...ROLE_ROW, permissionCount: 0, memberCount: 0 }),
  listTemplates: jest.fn().mockReturnValue([]),
};

const stubQuery = {
  getRoleAnalytics: jest.fn().mockResolvedValue({ totalRoles: 0, customRoles: 0, systemRoles: 0, totalPermissions: 0, usersAssigned: 0, recentChanges: 0 }),
  listSimulationCandidates: jest.fn().mockResolvedValue({ data: [], pagination: { limit: 20, hasMore: false, nextCursor: null } }),
  getSimulationTarget: jest.fn().mockResolvedValue({ isOwner: false }),
  listAssignableDepartments: jest.fn().mockResolvedValue([]),
};

const GROUP_ROW = { id: GROUP_UUID, orgId: "org_1", kind: "MANUAL", orgUnitId: null, name: "Test Group", createdAt: NOW, updatedAt: NOW };

const stubGroups = {
  list: jest.fn().mockResolvedValue({ data: [], pagination: { limit: 20, hasMore: false, nextCursor: null } }),
  create: jest.fn().mockResolvedValue(GROUP_ROW),
  rename: jest.fn().mockResolvedValue({ success: true as const }),
  getMembers: jest.fn().mockResolvedValue([]),
  addMember: jest.fn().mockResolvedValue({ success: true as const }),
  removeMember: jest.fn().mockResolvedValue({ success: true as const }),
  getAssignedRoles: jest.fn().mockResolvedValue([]),
  assignRole: jest.fn().mockResolvedValue({ success: true as const }),
  unassignRole: jest.fn().mockResolvedValue({ success: true as const }),
};

const ACCESS_SNAPSHOT = { scopes: {}, modules: {}, isOrgOwner: false, canManageOrganizationMembership: false, mfa: { enforced: false, satisfied: true }, version: 1 };

const SERVICE_OVERRIDES = [
  { provide: AccessService, useValue: { ...accessStub, getAccessSnapshot: jest.fn().mockResolvedValue(ACCESS_SNAPSHOT) } },
  { provide: RbacService, useValue: stubRbac },
  { provide: RolesService, useValue: stubRoles },
  { provide: RoleSeedService, useValue: stubSeed },
  { provide: RolesQueryService, useValue: stubQuery },
  { provide: PrincipalGroupsService, useValue: stubGroups },
];

type FenceCase = readonly [method: string, path: string, key: string, body: Record<string, unknown>, happyStatus: number];

const PERM_CASES: ReadonlyArray<FenceCase> = [
  ["GET",    "/rbac/permissions",               "settings:rbac:manage", {}, 200],
  ["POST",   "/rbac/role-permissions",          "settings:rbac:manage", { roleId: 1, permissionKey: "settings:view", scope: "all" }, 200],
  ["DELETE", "/rbac/role-permissions",          "settings:rbac:manage", { roleId: 1, permissionKey: "settings:view" }, 200],
  ["GET",    "/rbac/discovery/templates",       "settings:rbac:manage", {}, 200],
  ["GET",    "/rbac/discovery/members",         "settings:rbac:manage", {}, 200],
  ["GET",    "/principal-groups",               "settings:rbac:manage", {}, 200],
  ["POST",   "/principal-groups",               "settings:rbac:manage", { name: "Test Group" }, 201],
  ["PATCH",  `/principal-groups/${GROUP_UUID}`, "settings:rbac:manage", { name: "Renamed" }, 200],
  ["GET",    `/principal-groups/${GROUP_UUID}/members`, "settings:rbac:manage", {}, 200],
  ["POST",   `/principal-groups/${GROUP_UUID}/members`, "settings:rbac:manage", { membershipId: 1 }, 201],
  ["DELETE", `/principal-groups/${GROUP_UUID}/members/1`, "settings:rbac:manage", {}, 200],
  ["GET",    `/principal-groups/${GROUP_UUID}/roles`, "settings:rbac:manage", {}, 200],
  ["POST",   `/principal-groups/${GROUP_UUID}/roles`, "settings:rbac:manage", { roleId: 1 }, 201],
  ["DELETE", `/principal-groups/${GROUP_UUID}/roles/1`, "settings:rbac:manage", {}, 200],
  ["GET",    "/roles",                          "settings:rbac:manage", {}, 200],
  ["GET",    "/roles/analytics",                "settings:rbac:manage", {}, 200],
  ["GET",    "/roles/permissions/matrix",       "settings:rbac:manage", {}, 200],
  ["GET",    "/roles/simulate/candidates",      "settings:rbac:manage", {}, 200],
  ["GET",    "/roles/simulate/user_2",          "settings:rbac:manage", {}, 200],
  ["POST",   "/roles/seed-defaults",            "settings:rbac:manage", {}, 200],
  ["POST",   "/roles/templates",               "settings:rbac:manage", { templateId: "tpl_1" }, 201],
  ["GET",    "/roles/departments",             "settings:rbac:manage", {}, 200],
  ["GET",    "/roles/1",                        "settings:rbac:manage", {}, 200],
  ["PATCH",  "/roles/1",                        "settings:rbac:manage", { name: "Updated Role" }, 200],
  ["DELETE", "/roles/1",                        "settings:rbac:manage", {}, 200],
  ["GET",    "/roles/1/permissions",            "settings:rbac:manage", {}, 200],
  ["PUT",    "/roles/1/permissions",            "settings:rbac:manage", { version: 1, items: [] }, 200],
  ["GET",    "/roles/1/members",                "settings:rbac:manage", {}, 200],
  ["POST",   "/roles/1/members",               "settings:rbac:manage", { principalType: "user", principalId: "user_2" }, 201],
  ["DELETE", "/roles/1/members",               "settings:rbac:manage", { principalType: "user", principalId: "user_2" }, 200],
] as const;

const UNIVERSAL_CASES: ReadonlyArray<[method: string, path: string, body: Record<string, unknown>, happyStatus: number]> = [
  ["GET", "/rbac/access-snapshot",   {}, 200],
  ["GET", "/roles/templates",        {}, 200],
] as const;

const AUTHED_CASES: ReadonlyArray<[method: string, path: string, body: Record<string, unknown>, happyStatus: number]> = [
  ["GET", "/rbac/discovery/permissions", {}, 200],
  ["GET", "/rbac/discovery/grantable",   {}, 200],
] as const;

describe("RBAC permission fence — HTTP boundary", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp({ overrides: SERVICE_OVERRIDES });
  });

  afterAll(async () => {
    await app.close();
  });

  function call(method: string, path: string): request.Test {
    const agent = request(app.getHttpServer());
    if (method === "POST") return agent.post(path).set("Idempotency-Key", randomUUID());
    if (method === "PATCH") return agent.patch(path).set("Idempotency-Key", randomUUID());
    if (method === "DELETE") return agent.delete(path).set("Idempotency-Key", randomUUID());
    if (method === "PUT") return agent.put(path).set("Idempotency-Key", randomUUID());
    return agent.get(path);
  }

  describe("401 — unauthenticated request rejected", () => {
    it.each(PERM_CASES)("%s %s → 401 with no token", async (method, path, _key, body) => {
      const res = await call(method, path).send(body);
      expect(res.status).toBe(401);
    });

    it.each(UNIVERSAL_CASES)("%s %s → 401 with no token", async (method, path, body) => {
      const res = await call(method, path).send(body);
      expect(res.status).toBe(401);
    });

    it.each(AUTHED_CASES)("%s %s → 401 with no token", async (method, path, body) => {
      const res = await call(method, path).send(body);
      expect(res.status).toBe(401);
    });
  });

  describe("403 — authenticated but missing permission on @RequirePermission routes", () => {
    it.each(PERM_CASES)("%s %s → 403 with empty-permission token", async (method, path, _key, body) => {
      const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
      const res = await call(method, path).set("Authorization", `Bearer ${token}`).send(body);
      expect(res.status).toBe(403);
    });
  });

  describe("happy path — permission holder allowed", () => {
    it.each(PERM_CASES)("%s %s → %s with correct permission", async (method, path, key, body, happyStatus) => {
      const token = await signToken({ permissions: [key], enabledModules: ALL_MODULES });
      const res = await call(method, path).set("Authorization", `Bearer ${token}`).send(body);
      expect(res.status).toBe(happyStatus);
    });

    it.each(UNIVERSAL_CASES)("%s %s → %s with any auth token", async (method, path, body, happyStatus) => {
      const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
      const res = await call(method, path).set("Authorization", `Bearer ${token}`).send(body);
      expect(res.status).toBe(happyStatus);
    });

    it.each(AUTHED_CASES)("%s %s → %s with any auth token", async (method, path, body, happyStatus) => {
      const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
      const res = await call(method, path).set("Authorization", `Bearer ${token}`).send(body);
      expect(res.status).toBe(happyStatus);
    });
  });
});

describe("RBAC route coverage index — literal calls for gate script", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp({ overrides: SERVICE_OVERRIDES });
  });

  afterAll(async () => {
    await app.close();
  });

  it("all RBAC routes reject unauthenticated requests", async () => {
    const s = request(app.getHttpServer());
    await expect((await s.get("/rbac/permissions")).status).toBe(401);
    await expect((await s.post("/rbac/role-permissions").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.delete("/rbac/role-permissions").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.get("/rbac/access-snapshot")).status).toBe(401);
    await expect((await s.get("/rbac/discovery/permissions")).status).toBe(401);
    await expect((await s.get("/rbac/discovery/grantable")).status).toBe(401);
    await expect((await s.get("/rbac/discovery/templates")).status).toBe(401);
    await expect((await s.get("/rbac/discovery/members")).status).toBe(401);
    await expect((await s.get("/principal-groups")).status).toBe(401);
    await expect((await s.post("/principal-groups").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.patch("/principal-groups/00000000-0000-0000-0000-000000000001").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.get("/principal-groups/00000000-0000-0000-0000-000000000001/members")).status).toBe(401);
    await expect((await s.post("/principal-groups/00000000-0000-0000-0000-000000000001/members").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.delete("/principal-groups/00000000-0000-0000-0000-000000000001/members/1").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.get("/principal-groups/00000000-0000-0000-0000-000000000001/roles")).status).toBe(401);
    await expect((await s.post("/principal-groups/00000000-0000-0000-0000-000000000001/roles").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.delete("/principal-groups/00000000-0000-0000-0000-000000000001/roles/1").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.get("/roles")).status).toBe(401);
    await expect((await s.get("/roles/analytics")).status).toBe(401);
    await expect((await s.get("/roles/permissions/matrix")).status).toBe(401);
    await expect((await s.get("/roles/simulate/candidates")).status).toBe(401);
    await expect((await s.get("/roles/simulate/user_2")).status).toBe(401);
    await expect((await s.post("/roles/seed-defaults").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.get("/roles/templates")).status).toBe(401);
    await expect((await s.post("/roles/templates").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.get("/roles/departments")).status).toBe(401);
    await expect((await s.get("/roles/1")).status).toBe(401);
    await expect((await s.patch("/roles/1").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.delete("/roles/1").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.get("/roles/1/permissions")).status).toBe(401);
    await expect((await s.put("/roles/1/permissions").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.get("/roles/1/members")).status).toBe(401);
    await expect((await s.post("/roles/1/members").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.delete("/roles/1/members").set("Idempotency-Key", randomUUID())).status).toBe(401);
  });
});
