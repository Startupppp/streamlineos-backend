import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { ModuleAccessService } from "src/modules/module-access/module-access.service";
import { ModuleAccessGroupsService } from "src/modules/module-access/module-access-groups.service";
import { ModuleAccessRosterService } from "src/modules/module-access/module-access-roster.service";
import { ModuleAccessFlatMembersService } from "src/modules/module-access/module-access-flat-members.service";
import { ModuleAccessOwnershipService } from "src/modules/module-access/module-access-ownership.service";
import { ModuleStandingRosterService } from "src/modules/module-access/module-standing-roster.service";
import { ModuleStandingMutationsService } from "src/modules/module-access/module-standing-mutations.service";
import { UserPermissionGrantsService } from "src/modules/module-access/user-permission-grants.service";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const MOD = "crm";
const GROUP_ID = 1;
const MEMBERSHIP_ID = 1;
const USER_ID = "user_2";

const stubStandingRoster = {
  listStanding: jest.fn().mockResolvedValue({ administrable: true, entries: [] }),
  describeGrantable: jest.fn().mockResolvedValue({ grantableRanks: [], scopeCeiling: "all", canGrantModuleOwnership: false, isOrgOwner: false, isOrgAdmin: false }),
};

const stubStandingMutations = {
  grantAdminStanding: jest.fn().mockResolvedValue({ success: true as const }),
  revokeStanding: jest.fn().mockResolvedValue({ success: true as const }),
  directTransferOwnership: jest.fn().mockResolvedValue({ success: true as const }),
};

const MODULE_GROUP_ROW = { id: GROUP_ID, name: "Test Group", isSystem: false, version: 1, memberCount: 0, permissions: [] };

const stubGroups = {
  listGroups: jest.fn().mockResolvedValue({ data: [], pagination: { limit: 20, hasMore: false, nextCursor: null } }),
  createGroup: jest.fn().mockResolvedValue(MODULE_GROUP_ROW),
  renameGroup: jest.fn().mockResolvedValue(MODULE_GROUP_ROW),
  deleteGroup: jest.fn().mockResolvedValue({ success: true as const }),
  listGroupMembers: jest.fn().mockResolvedValue([]),
  addGroupMember: jest.fn().mockResolvedValue({ success: true as const }),
  removeGroupMember: jest.fn().mockResolvedValue({ success: true as const }),
};

const stubModuleAccess = {
  listCatalog: jest.fn().mockResolvedValue([]),
  listRoles: jest.fn().mockResolvedValue([]),
  setRolePermissions: jest.fn().mockResolvedValue({ success: true as const, version: 2 }),
  getCallerPermissions: jest.fn().mockResolvedValue({ permissions: [], isOrgOwner: false, isOrgAdmin: false, isModuleOwner: false, isModuleAdmin: false }),
  getAuditLog: jest.fn().mockResolvedValue({ data: [], pagination: { limit: 20, hasMore: false, nextCursor: null } }),
};

const stubRoster = {
  listMembers: jest.fn().mockResolvedValue({ data: [], hasMore: false, nextCursor: null }),
  listMemberCandidates: jest.fn().mockResolvedValue({ data: [], hasMore: false, nextCursor: null }),
};

const stubFlatMembers = {
  addMember: jest.fn().mockResolvedValue({ success: true as const }),
  updateMemberGroups: jest.fn().mockResolvedValue({ success: true as const }),
  removeMember: jest.fn().mockResolvedValue({ success: true as const }),
};

const stubOwnership = {
  getOwnership: jest.fn().mockResolvedValue({ moduleKey: MOD, ownerId: "user_1", ownerDisplayName: "Owner", ownerEmail: "owner@example.com", pendingTransfer: null }),
  initiateTransfer: jest.fn().mockResolvedValue({ success: true as const }),
  cancelTransfer: jest.fn().mockResolvedValue({ success: true as const }),
};

const stubGrants = {
  listGrants: jest.fn().mockResolvedValue({ grants: [] }),
  setGrants: jest.fn().mockResolvedValue({ success: true as const, granted: 0 }),
  removeGrant: jest.fn().mockResolvedValue({ success: true as const }),
};

const SERVICE_OVERRIDES = [
  { provide: ModuleAccessService, useValue: stubModuleAccess },
  { provide: ModuleAccessGroupsService, useValue: stubGroups },
  { provide: ModuleAccessRosterService, useValue: stubRoster },
  { provide: ModuleAccessFlatMembersService, useValue: stubFlatMembers },
  { provide: ModuleAccessOwnershipService, useValue: stubOwnership },
  { provide: ModuleStandingRosterService, useValue: stubStandingRoster },
  { provide: ModuleStandingMutationsService, useValue: stubStandingMutations },
  { provide: UserPermissionGrantsService, useValue: stubGrants },
];

type AuthedCase = readonly [method: string, path: string, body: Record<string, unknown>, happyStatus: number];

const MODULE_ACCESS_CASES: ReadonlyArray<AuthedCase> = [
  ["GET",    `/module-access/${MOD}/standing`,                         {}, 200],
  ["GET",    `/module-access/${MOD}/standing/grantable`,               {}, 200],
  ["POST",   `/module-access/${MOD}/standing/transfer-owner`,          { toMembershipId: MEMBERSHIP_ID }, 200],
  ["POST",   `/module-access/${MOD}/standing/${MEMBERSHIP_ID}`,        {}, 200],
  ["DELETE", `/module-access/${MOD}/standing/${MEMBERSHIP_ID}`,        {}, 200],
  ["GET",    `/module-access/${MOD}/catalog`,                          {}, 200],
  ["GET",    `/module-access/${MOD}/roles`,                            {}, 200],
  ["PUT",    `/module-access/${MOD}/roles/1/permissions`,              { version: 1, items: [] }, 200],
  ["GET",    `/module-access/${MOD}/groups`,                           {}, 200],
  ["POST",   `/module-access/${MOD}/groups`,                           { name: "Test Group" }, 201],
  ["PATCH",  `/module-access/${MOD}/groups/${GROUP_ID}`,               { name: "Renamed" }, 200],
  ["DELETE", `/module-access/${MOD}/groups/${GROUP_ID}`,               {}, 200],
  ["PUT",    `/module-access/${MOD}/groups/${GROUP_ID}/permissions`,   { version: 1, items: [] }, 200],
  ["GET",    `/module-access/${MOD}/groups/${GROUP_ID}/members`,       {}, 200],
  ["POST",   `/module-access/${MOD}/groups/${GROUP_ID}/members`,       { userId: USER_ID }, 201],
  ["DELETE", `/module-access/${MOD}/groups/${GROUP_ID}/members/${USER_ID}`, {}, 200],
  ["GET",    `/module-access/${MOD}/me/permissions`,                   {}, 200],
  ["GET",    `/module-access/${MOD}/members`,                          {}, 200],
  ["POST",   `/module-access/${MOD}/members`,                          { userId: USER_ID, groupIds: [GROUP_ID] }, 201],
  ["PATCH",  `/module-access/${MOD}/members/${USER_ID}`,               { groupIds: [GROUP_ID] }, 200],
  ["DELETE", `/module-access/${MOD}/members/${USER_ID}`,               {}, 200],
  ["GET",    `/module-access/${MOD}/audit-log`,                        {}, 200],
  ["GET",    `/module-access/${MOD}/member-candidates`,                {}, 200],
  ["GET",    `/module-access/${MOD}/ownership`,                        {}, 200],
  ["POST",   `/module-access/${MOD}/ownership/transfer`,               { toUserId: USER_ID }, 201],
  ["DELETE", `/module-access/${MOD}/ownership/transfer`,               {}, 200],
  ["GET",    `/module-access/${MOD}/members/${MEMBERSHIP_ID}/grants`,  {}, 200],
  ["PUT",    `/module-access/${MOD}/members/${MEMBERSHIP_ID}/grants`,  { items: [] }, 200],
  ["DELETE", `/module-access/${MOD}/members/${MEMBERSHIP_ID}/grants/some:key`, {}, 200],
] as const;

describe("Module-access permission fence — HTTP boundary", () => {
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
    it.each(MODULE_ACCESS_CASES)("%s %s → 401 with no token", async (method, path, body) => {
      const res = await call(method, path).send(body);
      expect(res.status).toBe(401);
    });
  });

  describe("happy path — authenticated caller allowed (@AuthorizedInService routes)", () => {
    it.each(MODULE_ACCESS_CASES)("%s %s → %s with owner token", async (method, path, body, happyStatus) => {
      const token = await signToken({ isOrgOwner: true, enabledModules: ALL_MODULES });
      const res = await call(method, path).set("Authorization", `Bearer ${token}`).send(body);
      expect(res.status).toBe(happyStatus);
    });
  });
});

describe("Module-access route coverage index — literal calls for gate script", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp({ overrides: SERVICE_OVERRIDES });
  });

  afterAll(async () => {
    await app.close();
  });

  it("all module-access routes reject unauthenticated requests", async () => {
    const s = request(app.getHttpServer());
    await expect((await s.get("/module-access/crm/standing")).status).toBe(401);
    await expect((await s.get("/module-access/crm/standing/grantable")).status).toBe(401);
    await expect((await s.post("/module-access/crm/standing/transfer-owner").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.post("/module-access/crm/standing/1").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.delete("/module-access/crm/standing/1").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.get("/module-access/crm/catalog")).status).toBe(401);
    await expect((await s.get("/module-access/crm/roles")).status).toBe(401);
    await expect((await s.put("/module-access/crm/roles/1/permissions").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.get("/module-access/crm/groups")).status).toBe(401);
    await expect((await s.post("/module-access/crm/groups").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.patch("/module-access/crm/groups/1").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.delete("/module-access/crm/groups/1").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.put("/module-access/crm/groups/1/permissions").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.get("/module-access/crm/groups/1/members")).status).toBe(401);
    await expect((await s.post("/module-access/crm/groups/1/members").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.delete("/module-access/crm/groups/1/members/user_2").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.get("/module-access/crm/me/permissions")).status).toBe(401);
    await expect((await s.get("/module-access/crm/members")).status).toBe(401);
    await expect((await s.post("/module-access/crm/members").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.patch("/module-access/crm/members/user_2").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.delete("/module-access/crm/members/user_2").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.get("/module-access/crm/audit-log")).status).toBe(401);
    await expect((await s.get("/module-access/crm/member-candidates")).status).toBe(401);
    await expect((await s.get("/module-access/crm/ownership")).status).toBe(401);
    await expect((await s.post("/module-access/crm/ownership/transfer").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.delete("/module-access/crm/ownership/transfer").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.get("/module-access/crm/members/1/grants")).status).toBe(401);
    await expect((await s.put("/module-access/crm/members/1/grants").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.delete("/module-access/crm/members/1/grants/some:key").set("Idempotency-Key", randomUUID())).status).toBe(401);
  });
});
