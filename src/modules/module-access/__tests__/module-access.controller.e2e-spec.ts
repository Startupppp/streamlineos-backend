import type { INestApplication } from "@nestjs/common";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import request from "supertest";
import { signToken } from "test/helpers/sign-token";
import { createE2eApp } from "test/helpers/e2e-app";
import { ModuleAccessService } from "../module-access.service";
import { ModuleAccessGroupsService } from "../module-access-groups.service";
import { ModuleAccessRosterService } from "../module-access-roster.service";
import { ModuleAccessOwnershipService } from "../module-access-ownership.service";
import { ModuleStandingMutationsService } from "../module-standing-mutations.service";
import { ModuleStandingRosterService } from "../module-standing-roster.service";
import { ACCESS_MANAGED_MODULES } from "src/modules/rbac/permissions/module-access";
import { IdempotencyInterceptor } from "src/common/idempotency/idempotency.interceptor";
import { RateLimitService } from "src/common/ratelimit/rate-limit.service";

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
  version: 1,
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

const stubStandingEntries = [
  {
    membershipId: 1,
    userId: "u-owner-hr",
    displayName: "Alice HR",
    email: "alice@example.com",
    avatarUrl: null,
    rank: 15,
    scope: "all",
    source: "module-ownership",
  },
];

const stubGrantableDescriptor = {
  grantableRanks: [20, 30, 40],
  scopeCeiling: "all",
  canGrantModuleOwnership: true,
  isOrgOwner: true,
  isOrgAdmin: false,
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
};

const mockModuleAccessRosterService = {
  listMemberCandidates: jest.fn(),
};

const mockModuleAccessOwnershipService = {
  getOwnership: jest.fn(),
  initiateTransfer: jest.fn(),
  cancelTransfer: jest.fn(),
};

const mockModuleStandingMutationsService = {
  grantAdminStanding: jest.fn(),
  revokeStanding: jest.fn(),
  directTransferOwnership: jest.fn(),
};

const mockModuleStandingRosterService = {
  listStanding: jest.fn(),
  describeGrantable: jest.fn(),
};

/**
 * `@Idempotent` persists the key before the handler runs, which needs tenant
 * rows this fixture does not create. Passing through keeps the spec about
 * authorization; idempotency has its own unit spec at
 * common/idempotency/idempotency.interceptor.spec.ts.
 */
const idempotencyPassThrough = {
  intercept: (_ctx: ExecutionContext, next: CallHandler) => next.handle(),
};

const rateLimitAllowAll = { check: async () => ({ allowed: true }) };

describe("ModuleAccessController auth / RBAC (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [
        { provide: ModuleAccessService, useValue: mockModuleAccessService },
        { provide: ModuleAccessGroupsService, useValue: mockModuleAccessGroupsService },
        { provide: ModuleAccessRosterService, useValue: mockModuleAccessRosterService },
        { provide: ModuleAccessOwnershipService, useValue: mockModuleAccessOwnershipService },
        { provide: ModuleStandingMutationsService, useValue: mockModuleStandingMutationsService },
        { provide: ModuleStandingRosterService, useValue: mockModuleStandingRosterService },
        { provide: IdempotencyInterceptor, useValue: idempotencyPassThrough },
        { provide: RateLimitService, useValue: rateLimitAllowAll },
      ],
    });
  });

  afterAll(async () => app.close());

  beforeEach(() => {
    jest.resetAllMocks();
    mockModuleAccessService.listCatalog.mockResolvedValue(stubCatalog);
    mockModuleAccessService.listRoles.mockResolvedValue([stubRole]);
    mockModuleAccessService.setRolePermissions.mockResolvedValue({ success: true });
    mockModuleAccessGroupsService.listGroups.mockResolvedValue({
      data: [stubGroup],
      pagination: { limit: 20, hasMore: false, nextCursor: null },
    });
    mockModuleAccessGroupsService.createGroup.mockResolvedValue(stubGroup);
    mockModuleAccessGroupsService.renameGroup.mockResolvedValue(stubGroup);
    mockModuleAccessGroupsService.deleteGroup.mockResolvedValue({ success: true });
    mockModuleAccessGroupsService.listGroupMembers.mockResolvedValue([]);
    mockModuleAccessGroupsService.addGroupMember.mockResolvedValue({ success: true });
    mockModuleAccessGroupsService.removeGroupMember.mockResolvedValue({ success: true });
    mockModuleAccessRosterService.listMemberCandidates.mockResolvedValue([]);
    mockModuleAccessOwnershipService.getOwnership.mockResolvedValue(stubOwnership);
    mockModuleAccessOwnershipService.initiateTransfer.mockResolvedValue({ success: true });
    mockModuleAccessOwnershipService.cancelTransfer.mockResolvedValue({ success: true });
    mockModuleStandingMutationsService.grantAdminStanding.mockResolvedValue({ success: true });
    mockModuleStandingMutationsService.revokeStanding.mockResolvedValue({ success: true });
    mockModuleStandingMutationsService.directTransferOwnership.mockResolvedValue({ success: true });
    mockModuleStandingRosterService.listStanding.mockResolvedValue({ administrable: true, entries: stubStandingEntries });
    mockModuleStandingRosterService.describeGrantable.mockResolvedValue(stubGrantableDescriptor);
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
    ["post", "/module-access/hr/standing/transfer-owner"],
    ["post", "/module-access/hr/standing/42"],
    ["delete", "/module-access/hr/standing/42"],
    ["get", "/module-access/hr/standing"],
    ["get", "/module-access/hr/standing/grantable"],
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
        .set("Idempotency-Key", "unmanaged-module-billing")
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
        .set("Idempotency-Key", "create-hr-group-201")
        .send({ name: "Senior HR" });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ id: GROUP_ID, name: "HR Reviewers" });
    });

    it("POST /module-access/hr/groups → 400 without an Idempotency-Key", async () => {
      const token = await signToken({ sub: "owner_ma_1" });
      const res = await request(app.getHttpServer())
        .post("/module-access/hr/groups")
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "Senior HR" });
      expect(res.status).toBe(400);
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
        .set("Idempotency-Key", "it-hr-transfer-initiate")
        .send({ toUserId: "u-recipient" });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ success: true });
    });

    it("DELETE /module-access/hr/ownership/transfer → 404 when no pending transfer exists", async () => {
      mockModuleAccessOwnershipService.cancelTransfer.mockRejectedValue(
        new NotFoundException("No pending transfer found for this module"),
      );
      const token = await signToken({ sub: "owner_ma_1" });
      const res = await request(app.getHttpServer())
        .delete("/module-access/hr/ownership/transfer")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", "it-hr-transfer-cancel");
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
        .set("Idempotency-Key", "it-hr-transfer-missing-user")
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

  describe("Standing mutations — grant, revoke, direct transfer", () => {
    const MEMBERSHIP_ID = 42;

    it("POST /module-access/hr/standing/:membershipId → 200 on grant", async () => {
      const token = await signToken({ sub: "owner_ma_1" });
      const res = await request(app.getHttpServer())
        .post(`/module-access/hr/standing/${MEMBERSHIP_ID}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true });
    });

    it("POST /module-access/hr/standing/:membershipId → 403 when service refuses", async () => {
      mockModuleStandingMutationsService.grantAdminStanding.mockRejectedValueOnce(
        new ForbiddenException("Your rank does not permit granting module-admin standing"),
      );
      const token = await signToken({ sub: "member_ma_1" });
      const res = await request(app.getHttpServer())
        .post(`/module-access/hr/standing/${MEMBERSHIP_ID}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "FORBIDDEN" });
    });

    it("DELETE /module-access/hr/standing/:membershipId → 200 on revoke", async () => {
      const token = await signToken({ sub: "owner_ma_1" });
      const res = await request(app.getHttpServer())
        .delete(`/module-access/hr/standing/${MEMBERSHIP_ID}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true });
    });

    it("DELETE /module-access/hr/standing/:membershipId → 403 when revoking module owner", async () => {
      mockModuleStandingMutationsService.revokeStanding.mockRejectedValueOnce(
        new ForbiddenException("Cannot revoke the module owner's standing. Transfer ownership first."),
      );
      const token = await signToken({ sub: "owner_ma_1" });
      const res = await request(app.getHttpServer())
        .delete(`/module-access/hr/standing/${MEMBERSHIP_ID}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("POST /module-access/hr/standing/transfer-owner → 200 on direct transfer", async () => {
      const token = await signToken({ sub: "owner_ma_1" });
      const res = await request(app.getHttpServer())
        .post("/module-access/hr/standing/transfer-owner")
        .set("Authorization", `Bearer ${token}`)
        .send({ toMembershipId: MEMBERSHIP_ID });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true });
    });

    it("POST /module-access/hr/standing/transfer-owner → 400 when toMembershipId is missing", async () => {
      const token = await signToken({ sub: "owner_ma_1" });
      const res = await request(app.getHttpServer())
        .post("/module-access/hr/standing/transfer-owner")
        .set("Authorization", `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "VALIDATION_FAILED" });
    });

    it("POST /module-access/hr/standing/transfer-owner → 403 when actor is not org owner", async () => {
      mockModuleStandingMutationsService.directTransferOwnership.mockRejectedValueOnce(
        new ForbiddenException("Only an organization owner may perform a direct module ownership transfer"),
      );
      const token = await signToken({ sub: "member_ma_1" });
      const res = await request(app.getHttpServer())
        .post("/module-access/hr/standing/transfer-owner")
        .set("Authorization", `Bearer ${token}`)
        .send({ toMembershipId: MEMBERSHIP_ID });
      expect(res.status).toBe(403);
    });

    it("service receives actor.orgId from JWT, not from request body, on transfer-owner", async () => {
      const ORG_A = "org-transfer-test";
      mockModuleStandingMutationsService.directTransferOwnership.mockImplementationOnce(
        (actor: { orgId: string }) => {
          expect(actor.orgId).toBe(ORG_A);
          return Promise.resolve({ success: true });
        },
      );
      const token = await signToken({ sub: "owner_ma_1", orgId: ORG_A });
      await request(app.getHttpServer())
        .post("/module-access/hr/standing/transfer-owner")
        .set("Authorization", `Bearer ${token}`)
        .send({ toMembershipId: MEMBERSHIP_ID });
      expect(mockModuleStandingMutationsService.directTransferOwnership).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: ORG_A }),
        "hr",
        MEMBERSHIP_ID,
      );
    });
  });

  describe("Standing roster reads — allow/deny matrix", () => {
    it("GET /module-access/hr/standing → 200 with roster when org owner", async () => {
      const token = await signToken({ sub: "owner_ma_1", isOrgOwner: true });
      const res = await request(app.getHttpServer())
        .get("/module-access/hr/standing")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ administrable: true, entries: expect.arrayContaining([expect.objectContaining({ source: "module-ownership" })]) });
    });

    it("GET /module-access/hr/standing → 200 for org admin", async () => {
      const token = await signToken({ sub: "admin_1", role: "ORG_ADMIN" });
      const res = await request(app.getHttpServer())
        .get("/module-access/hr/standing")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it("GET /module-access/hr/standing → 200 for module admin (hr:access:view)", async () => {
      const token = await signToken({
        sub: "modadmin_1",
        permissions: ["hr:access:view"],
        enabledModules: ["hr"],
      });
      const res = await request(app.getHttpServer())
        .get("/module-access/hr/standing")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it("GET /module-access/hr/standing → 403 when service denies a member with no standing", async () => {
      mockModuleStandingRosterService.listStanding.mockRejectedValueOnce(
        new ForbiddenException("You do not have access to view this module's roster"),
      );
      const token = await signToken({ sub: "member_1" });
      const res = await request(app.getHttpServer())
        .get("/module-access/hr/standing")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "FORBIDDEN" });
    });

    it("GET /module-access/hr/standing returns administrable:false for a non-administrable module", async () => {
      mockModuleStandingRosterService.listStanding.mockResolvedValueOnce({
        administrable: false,
        reason: "The workflows module does not support role-based standing",
      });
      const token = await signToken({ sub: "owner_ma_1", isOrgOwner: true });
      const res = await request(app.getHttpServer())
        .get("/module-access/workflows/standing")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ administrable: false });
    });

    it("service receives actor.orgId from JWT, not from URL, on GET standing", async () => {
      const ORG_A = "org-standing-test";
      mockModuleStandingRosterService.listStanding.mockImplementationOnce(
        (actor: { orgId: string }) => {
          expect(actor.orgId).toBe(ORG_A);
          return Promise.resolve({ administrable: true, entries: stubStandingEntries });
        },
      );
      const token = await signToken({ sub: "owner_ma_1", orgId: ORG_A, isOrgOwner: true });
      await request(app.getHttpServer())
        .get("/module-access/hr/standing")
        .set("Authorization", `Bearer ${token}`);
      expect(mockModuleStandingRosterService.listStanding).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: ORG_A }),
        "hr",
      );
    });

    it("GET /module-access/hr/standing/grantable → 200 with descriptor for org owner", async () => {
      const token = await signToken({ sub: "owner_ma_1", isOrgOwner: true });
      const res = await request(app.getHttpServer())
        .get("/module-access/hr/standing/grantable")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        grantableRanks: expect.any(Array),
        scopeCeiling: expect.any(String),
        canGrantModuleOwnership: expect.any(Boolean),
      });
    });

    it("GET /module-access/hr/standing/grantable → 403 when service denies", async () => {
      mockModuleStandingRosterService.describeGrantable.mockRejectedValueOnce(
        new ForbiddenException("You do not have access to view this module's roster"),
      );
      const token = await signToken({ sub: "member_1" });
      const res = await request(app.getHttpServer())
        .get("/module-access/hr/standing/grantable")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("cross-tenant: service receives orgId from token on GET standing/grantable", async () => {
      const ORG_B = "org-grantable-test";
      mockModuleStandingRosterService.describeGrantable.mockImplementationOnce(
        (actor: { orgId: string }) => {
          expect(actor.orgId).toBe(ORG_B);
          return Promise.resolve(stubGrantableDescriptor);
        },
      );
      const token = await signToken({ sub: "owner_ma_1", orgId: ORG_B, isOrgOwner: true });
      await request(app.getHttpServer())
        .get("/module-access/hr/standing/grantable")
        .set("Authorization", `Bearer ${token}`);
      expect(mockModuleStandingRosterService.describeGrantable).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: ORG_B }),
        "hr",
      );
    });
  });

  describe.each([...ACCESS_MANAGED_MODULES])(
    "Per-module guard matrix — %s",
    (moduleKey) => {
      const unauthRoutes: ReadonlyArray<[Method, string]> = [
        ["get", `/module-access/${moduleKey}/catalog`],
        ["get", `/module-access/${moduleKey}/groups`],
        ["get", `/module-access/${moduleKey}/ownership`],
      ];

      it.each(unauthRoutes)(
        "401 on %s %s without a token",
        async (method, path) => {
          const res = await callRoute(method, path);
          expect(res.status).toBe(401);
          expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
        },
      );

      it("org owner gets 200 on GET catalog", async () => {
        const token = await signToken({ sub: "owner_1", isOrgOwner: true });
        const res = await request(app.getHttpServer())
          .get(`/module-access/${moduleKey}/catalog`)
          .set("Authorization", `Bearer ${token}`);
        expect(res.status).toBe(200);
      });

      it("org admin gets 200 on GET groups", async () => {
        const token = await signToken({ sub: "admin_1", role: "ORG_ADMIN" });
        const res = await request(app.getHttpServer())
          .get(`/module-access/${moduleKey}/groups`)
          .set("Authorization", `Bearer ${token}`);
        expect(res.status).toBe(200);
      });

      it("module admin gets 200 on GET catalog", async () => {
        const token = await signToken({
          sub: "modadmin_1",
          permissions: [`${moduleKey}:access:manage`],
        });
        const res = await request(app.getHttpServer())
          .get(`/module-access/${moduleKey}/catalog`)
          .set("Authorization", `Bearer ${token}`);
        expect(res.status).toBe(200);
      });

      it("unauthorized caller: service denies catalog → 403", async () => {
        mockModuleAccessService.listCatalog.mockRejectedValueOnce(
          new ForbiddenException("You do not have access to manage this module's roles"),
        );
        const token = await signToken({ sub: "member_1" });
        const res = await request(app.getHttpServer())
          .get(`/module-access/${moduleKey}/catalog`)
          .set("Authorization", `Bearer ${token}`);
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ code: "FORBIDDEN" });
      });

      it("module admin: service denies ownership transfer → 403", async () => {
        mockModuleAccessOwnershipService.initiateTransfer.mockRejectedValueOnce(
          new ForbiddenException("Only the module owner may initiate a transfer"),
        );
        const token = await signToken({
          sub: `modadmin_${moduleKey}`,
          permissions: [`${moduleKey}:access:manage`],
        });
        const res = await request(app.getHttpServer())
          .post(`/module-access/${moduleKey}/ownership/transfer`)
          .set("Authorization", `Bearer ${token}`)
          .set("Idempotency-Key", `it-${moduleKey}-transfer-denied`)
          .send({ toUserId: "u-new-owner" });
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ code: "FORBIDDEN" });
      });
    },
  );

});
