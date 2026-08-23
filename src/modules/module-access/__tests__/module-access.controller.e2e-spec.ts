import type { INestApplication } from "@nestjs/common";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import request from "supertest";
import { signToken } from "test/helpers/sign-token";
import { createE2eApp } from "test/helpers/e2e-app";
import { ModuleAccessService } from "../module-access.service";
import { ModuleAccessGroupsService } from "../module-access-groups.service";

const ROLE_ID = 7;
const GROUP_ID = 9;
const MEMBER_USER_ID = "u-member-001";

const stubCatalog = [
  { name: "hr:employees:view", resource: "hr:employees", action: "view", description: "View employees" },
];

const stubRole = {
  roleId: ROLE_ID,
  name: "HR Viewer",
  slug: "HR_VIEWER",
  isSystem: false,
  permissions: [{ permissionKey: "hr:employees:view", scope: "all" }],
};

const stubGroup = {
  id: GROUP_ID,
  name: "HR Reviewers",
  isSystem: false,
  memberCount: 2,
  permissions: [],
};

const stubOwnership = {
  moduleKey: "hr",
  ownerId: "u-owner-hr",
  ownerDisplayName: "Alice HR",
  ownerEmail: "alice@example.com",
  pendingTransfer: null,
};

const mockModuleAccessService = {
  listCatalog: jest.fn(),
  listRoles: jest.fn(),
  setRolePermissions: jest.fn(),
};

const mockModuleAccessGroupsService = {
  listGroups: jest.fn(),
  createGroup: jest.fn(),
  renameGroup: jest.fn(),
  deleteGroup: jest.fn(),
  listGroupMembers: jest.fn(),
  addGroupMember: jest.fn(),
  removeGroupMember: jest.fn(),
  listMemberCandidates: jest.fn(),
  getOwnership: jest.fn(),
  initiateOwnershipTransfer: jest.fn(),
  cancelOwnershipTransfer: jest.fn(),
};

describe("ModuleAccessController auth / RBAC (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [
        { provide: ModuleAccessService, useValue: mockModuleAccessService },
        { provide: ModuleAccessGroupsService, useValue: mockModuleAccessGroupsService },
      ],
    });
  });

  afterAll(async () => app.close());

  beforeEach(() => {
    jest.clearAllMocks();
    mockModuleAccessService.listCatalog.mockResolvedValue(stubCatalog);
    mockModuleAccessService.listRoles.mockResolvedValue([stubRole]);
    mockModuleAccessService.setRolePermissions.mockResolvedValue({ success: true });
    mockModuleAccessGroupsService.listGroups.mockResolvedValue([stubGroup]);
    mockModuleAccessGroupsService.createGroup.mockResolvedValue(stubGroup);
    mockModuleAccessGroupsService.renameGroup.mockResolvedValue(stubGroup);
    mockModuleAccessGroupsService.deleteGroup.mockResolvedValue({ success: true });
    mockModuleAccessGroupsService.listGroupMembers.mockResolvedValue([]);
    mockModuleAccessGroupsService.addGroupMember.mockResolvedValue({ success: true });
    mockModuleAccessGroupsService.removeGroupMember.mockResolvedValue({ success: true });
    mockModuleAccessGroupsService.listMemberCandidates.mockResolvedValue([]);
    mockModuleAccessGroupsService.getOwnership.mockResolvedValue(stubOwnership);
    mockModuleAccessGroupsService.initiateOwnershipTransfer.mockResolvedValue({ success: true });
    mockModuleAccessGroupsService.cancelOwnershipTransfer.mockResolvedValue({ success: true });
  });

  type Method = "get" | "post" | "put" | "patch" | "delete";

  function callRoute(method: Method, path: string): request.Test {
    const agent = request(app.getHttpServer());
    switch (method) {
      case "get": return agent.get(path);
      case "post": return agent.post(path);
      case "put": return agent.put(path);
      case "patch": return agent.patch(path);
      case "delete": return agent.delete(path);
    }
  }

  const authedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/module-access/hr/catalog"],
    ["get", "/module-access/hr/roles"],
    ["put", `/module-access/hr/roles/${ROLE_ID}/permissions`],
    ["get", "/module-access/hr/groups"],
    ["post", "/module-access/hr/groups"],
    ["patch", `/module-access/hr/groups/${GROUP_ID}`],
    ["delete", `/module-access/hr/groups/${GROUP_ID}`],
    ["put", `/module-access/hr/groups/${GROUP_ID}/permissions`],
    ["get", `/module-access/hr/groups/${GROUP_ID}/members`],
    ["post", `/module-access/hr/groups/${GROUP_ID}/members`],
    ["delete", `/module-access/hr/groups/${GROUP_ID}/members/${MEMBER_USER_ID}`],
    ["get", "/module-access/hr/member-candidates"],
    ["get", "/module-access/hr/ownership"],
    ["post", "/module-access/hr/ownership/transfer"],
    ["delete", "/module-access/hr/ownership/transfer"],
  ];

  it.each(authedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  describe("Authorization — who may read module access screens", () => {
    it("org owner can read catalog without any explicit permission grant", async () => {
      const token = await signToken({ sub: "owner_ma_1" });
      const res = await request(app.getHttpServer())
        .get("/module-access/hr/catalog")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it("platform admin can read catalog without any explicit permission grant", async () => {
      const token = await signToken({ sub: "member_ma_1" });
      const res = await request(app.getHttpServer())
        .get("/module-access/hr/catalog")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it("org admin (settings:rbac:manage) can read catalog", async () => {
      mockModuleAccessService.listCatalog.mockResolvedValue(stubCatalog);
      const token = await signToken({ sub: "member_ma_1" });
      const res = await request(app.getHttpServer())
        .get("/module-access/hr/catalog")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it("module admin (hr:access:view) can read catalog", async () => {
      mockModuleAccessService.listCatalog.mockResolvedValue(stubCatalog);
      const token = await signToken({ sub: "member_ma_1" });
      const res = await request(app.getHttpServer())
        .get("/module-access/hr/catalog")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it("regular user denied by service → 403 response", async () => {
      mockModuleAccessService.listCatalog.mockRejectedValue(
        new ForbiddenException("You do not have access to manage this module's roles"),
      );
      const token = await signToken({ sub: "member_ma_1" });
      const res = await request(app.getHttpServer())
        .get("/module-access/hr/catalog")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("regular user without groups access → 403 on GET groups", async () => {
      mockModuleAccessGroupsService.listGroups.mockRejectedValue(
        new ForbiddenException("You do not have access to manage this module's roles"),
      );
      const token = await signToken({ sub: "member_ma_1" });
      const res = await request(app.getHttpServer())
        .get("/module-access/hr/groups")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });
  });

  describe("Module isolation — admin of module X cannot access module Y", () => {
    it("service throws ForbiddenException for CRM groups when user only has HR access → 403", async () => {
      mockModuleAccessGroupsService.listGroups.mockRejectedValue(
        new ForbiddenException("You do not have access to manage this module's roles"),
      );
      const token = await signToken({ sub: "member_ma_1" });
      const res = await request(app.getHttpServer())
        .get("/module-access/crm/groups")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("service throws ForbiddenException when posting member to a CRM group with only HR access → 403", async () => {
      mockModuleAccessGroupsService.addGroupMember.mockRejectedValue(
        new ForbiddenException("You do not have access to manage this module's roles"),
      );
      const token = await signToken({ sub: "member_ma_1" });
      const res = await request(app.getHttpServer())
        .post(`/module-access/crm/groups/${GROUP_ID}/members`)
        .set("Authorization", `Bearer ${token}`)
        .send({ userId: MEMBER_USER_ID });
      expect(res.status).toBe(403);
    });

    it("setRolePermissions for a different module returns 403 via service", async () => {
      mockModuleAccessService.setRolePermissions.mockRejectedValue(
        new ForbiddenException("You do not have access to manage this module's roles"),
      );
      const token = await signToken({ sub: "member_ma_1" });
      const res = await request(app.getHttpServer())
        .put(`/module-access/crm/roles/${ROLE_ID}/permissions`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          version: 1,
          items: [{ permissionKey: "crm:leads:view", scope: "all" }],
        });
      expect(res.status).toBe(403);
    });
  });

  describe("Permission namespace enforcement — cannot grant permissions outside the module", () => {
    it("PUT /module-access/hr/roles/:id/permissions → 400 when permission key is outside the hr namespace", async () => {
      mockModuleAccessService.setRolePermissions.mockRejectedValue(
        new BadRequestException(
          `Permission "crm:leads:view" is not part of the hr module`,
        ),
      );
      const token = await signToken({ sub: "owner_ma_1" });
      const res = await request(app.getHttpServer())
        .put(`/module-access/hr/roles/${ROLE_ID}/permissions`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          version: 1,
          items: [{ permissionKey: "crm:leads:view", scope: "all" }],
        });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("crm:leads:view") });
    });

    it("PUT /module-access/hr/groups/:id/permissions → 400 when permission key is outside hr namespace", async () => {
      mockModuleAccessService.setRolePermissions.mockRejectedValue(
        new BadRequestException(
          `Permission "inventory:products:view" is not part of the hr module`,
        ),
      );
      const token = await signToken({ sub: "owner_ma_1" });
      const res = await request(app.getHttpServer())
        .put(`/module-access/hr/groups/${GROUP_ID}/permissions`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          version: 1,
          items: [{ permissionKey: "inventory:products:view", scope: "all" }],
        });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("inventory:products:view") });
    });

    it("module admin cannot grant a permission they do not hold themselves → 403", async () => {
      mockModuleAccessService.setRolePermissions.mockRejectedValue(
        new ForbiddenException(
          "You cannot grant permissions you do not hold: hr:employees:delete",
        ),
      );
      const token = await signToken({ sub: "member_ma_1" });
      const res = await request(app.getHttpServer())
        .put(`/module-access/hr/roles/${ROLE_ID}/permissions`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          version: 1,
          items: [{ permissionKey: "hr:employees:delete", scope: "all" }],
        });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("cannot grant") });
    });
  });

  describe("Unknown / unmanaged module", () => {
    it("GET /module-access/billing/catalog → 404 (billing is not in ACCESS_MANAGED_MODULES)", async () => {
      mockModuleAccessService.listCatalog.mockRejectedValue(
        new NotFoundException(`Access is not separately managed for module "billing"`),
      );
      const token = await signToken({ sub: "owner_ma_1" });
      const res = await request(app.getHttpServer())
        .get("/module-access/billing/catalog")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(404);
    });

    it("POST /module-access/billing/groups → 404 for an unmanaged module", async () => {
      mockModuleAccessGroupsService.createGroup.mockRejectedValue(
        new NotFoundException(`Access is not separately managed for module "billing"`),
      );
      const token = await signToken({ sub: "owner_ma_1" });
      const res = await request(app.getHttpServer())
        .post("/module-access/billing/groups")
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "Billing Admins" });
      expect(res.status).toBe(404);
    });
  });

  describe("Cross-tenant isolation", () => {
    it("all service calls receive the orgId from the JWT, never from request params", async () => {
      const ORG_A = "org-alpha-ma";
      mockModuleAccessService.listCatalog.mockImplementation(
        (actor: { orgId: string }) => {
          expect(actor.orgId).toBe(ORG_A);
          return Promise.resolve(stubCatalog);
        },
      );
      const token = await signToken({ sub: "owner_ma_1", orgId: ORG_A });
      await request(app.getHttpServer())
        .get("/module-access/hr/catalog")
        .set("Authorization", `Bearer ${token}`);
      expect(mockModuleAccessService.listCatalog).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: ORG_A }),
        "hr",
      );
    });

    it("org A member cannot view org B groups — service returns 403 for wrong org context", async () => {
      mockModuleAccessGroupsService.listGroups.mockRejectedValue(
        new ForbiddenException("You do not have access to manage this module's roles"),
      );
      const token = await signToken({ sub: "member_ma_1", orgId: "org-beta" });
      const res = await request(app.getHttpServer())
        .get("/module-access/hr/groups")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("service receives the orgId from the token when adding a group member", async () => {
      const ORG_A = "org-alpha-member-add";
      mockModuleAccessGroupsService.addGroupMember.mockImplementation(
        (actor: { orgId: string }) => {
          expect(actor.orgId).toBe(ORG_A);
          return Promise.resolve({ success: true });
        },
      );
      const token = await signToken({ sub: "owner_ma_1", orgId: ORG_A });
      await request(app.getHttpServer())
        .post(`/module-access/hr/groups/${GROUP_ID}/members`)
        .set("Authorization", `Bearer ${token}`)
        .send({ userId: MEMBER_USER_ID });
      expect(mockModuleAccessGroupsService.addGroupMember).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: ORG_A }),
        "hr",
        GROUP_ID,
        { userId: MEMBER_USER_ID },
      );
    });
  });

  describe("Group lifecycle — create/rename/delete success paths", () => {
    it("POST /module-access/hr/groups → 201 with group data", async () => {
      const token = await signToken({ sub: "owner_ma_1" });
      const res = await request(app.getHttpServer())
        .post("/module-access/hr/groups")
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "Senior HR" });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ id: GROUP_ID, name: "HR Reviewers" });
    });

    it("DELETE /module-access/hr/groups/:id → 200 on successful deletion", async () => {
      const token = await signToken({ sub: "owner_ma_1" });
      const res = await request(app.getHttpServer())
        .delete(`/module-access/hr/groups/${GROUP_ID}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true });
    });

    it("DELETE /module-access/hr/groups/:id → 409 when group still has members", async () => {
      mockModuleAccessGroupsService.deleteGroup.mockRejectedValue(
        new ConflictException(
          "Cannot delete a group with active member assignments. Remove all members first.",
        ),
      );
      const token = await signToken({ sub: "owner_ma_1" });
      const res = await request(app.getHttpServer())
        .delete(`/module-access/hr/groups/${GROUP_ID}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(409);
    });

    it("PATCH /module-access/hr/groups/:id → 403 when renaming a system group", async () => {
      mockModuleAccessGroupsService.renameGroup.mockRejectedValue(
        new ForbiddenException("System groups cannot be renamed"),
      );
      const token = await signToken({ sub: "owner_ma_1" });
      const res = await request(app.getHttpServer())
        .patch(`/module-access/hr/groups/${GROUP_ID}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "New Name" });
      expect(res.status).toBe(403);
    });
  });

  describe("Ownership transfer within module-access screen", () => {
    it("POST /module-access/hr/ownership/transfer → 201 when the authenticated org-owner request delegates successfully", async () => {
      const token = await signToken({ sub: "owner_ma_1" });
      const res = await request(app.getHttpServer())
        .post("/module-access/hr/ownership/transfer")
        .set("Authorization", `Bearer ${token}`)
        .send({ toUserId: "u-recipient" });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ success: true });
    });

    it("DELETE /module-access/hr/ownership/transfer → 404 when no pending transfer exists", async () => {
      mockModuleAccessGroupsService.cancelOwnershipTransfer.mockRejectedValue(
        new NotFoundException("No pending transfer found for this module"),
      );
      const token = await signToken({ sub: "owner_ma_1" });
      const res = await request(app.getHttpServer())
        .delete("/module-access/hr/ownership/transfer")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(404);
    });
  });

  describe("Input validation", () => {
    it("POST /module-access/hr/groups → 400 when name is missing", async () => {
      const token = await signToken({ sub: "owner_ma_1" });
      const res = await request(app.getHttpServer())
        .post("/module-access/hr/groups")
        .set("Authorization", `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "VALIDATION_FAILED" });
    });

    it("PUT /module-access/hr/roles/:id/permissions → 400 when items array is missing", async () => {
      const token = await signToken({ sub: "owner_ma_1" });
      const res = await request(app.getHttpServer())
        .put(`/module-access/hr/roles/${ROLE_ID}/permissions`)
        .set("Authorization", `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "VALIDATION_FAILED" });
    });

    it("POST /module-access/hr/ownership/transfer → 400 when toUserId is missing", async () => {
      const token = await signToken({ sub: "owner_ma_1" });
      const res = await request(app.getHttpServer())
        .post("/module-access/hr/ownership/transfer")
        .set("Authorization", `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "VALIDATION_FAILED" });
    });

    it("GET /module-access/invalid key!/catalog → 400 due to moduleKey regex failure", async () => {
      const token = await signToken({ sub: "owner_ma_1" });
      const res = await request(app.getHttpServer())
        .get("/module-access/INVALID%20KEY/catalog")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "VALIDATION_FAILED" });
    });
  });

  describe("Home has no access administration to route to", () => {
    const homeRoutes: ReadonlyArray<[Method, string]> = [
      ["get", "/module-access/home/catalog"],
      ["get", "/module-access/home/roles"],
      ["get", "/module-access/home/groups"],
      ["get", "/module-access/home/ownership"],
    ];

    it.each(homeRoutes)("401 on %s %s without a token", async (method, path) => {
      const res = await callRoute(method, path);
      expect(res.status).toBe(401);
    });

    it.each(homeRoutes)("404 on %s %s for a real caller", async (method, path) => {
      const token = await signToken({ sub: "owner_ma_1" });
      const res = await callRoute(method, path).set(
        "Authorization",
        `Bearer ${token}`,
      );
      expect(res.status).toBe(404);
    });

    it("never reaches the service, so there is nothing to authorize", async () => {
      const token = await signToken({ sub: "owner_ma_1" });
      await request(app.getHttpServer())
        .get("/module-access/home/catalog")
        .set("Authorization", `Bearer ${token}`);
      expect(mockModuleAccessService.listCatalog).not.toHaveBeenCalled();
    });
  });
});
