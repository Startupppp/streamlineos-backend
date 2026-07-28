import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../../app.module";
import { AllExceptionsFilter } from "../../../common/http/all-exceptions.filter";
import { signToken } from "../../../../test/helpers/sign-token";
import { OwnershipService } from "../ownership.service";
import { AccessService } from "../../access/access.service";

const TRANSFER_ID = "c8a3e1f0-aaaa-bbbb-cccc-d9e7f0a1b2c3";

const stubOwnership = {
  moduleKey: "hr",
  ownerMembershipId: 1,
  ownerUserId: "u_owner_1",
  ownerName: "Alice",
  ownerEmail: "alice@example.com",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const stubTransferResponse = {
  transferId: TRANSFER_ID,
  expiresAt: new Date(Date.now() + 48 * 3_600_000).toISOString(),
};

const stubListResponse = {
  data: [],
  pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
};

const mockOwnershipService = {
  listModuleOwnerships: jest.fn(),
  getModuleOwnership: jest.fn(),
  forceSetModuleOwner: jest.fn(),
  initiateOrgTransfer: jest.fn(),
  initiateModuleTransfer: jest.fn(),
  listTransfers: jest.fn(),
  acceptTransfer: jest.fn(),
  declineTransfer: jest.fn(),
  cancelTransfer: jest.fn(),
};

const mockAccessService = {
  resolveUserPermissions: jest.fn(),
  isModuleEnabled: jest.fn(),
};

describe("OwnershipController auth / RBAC (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);

    const ref = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OwnershipService)
      .useValue(mockOwnershipService)
      .overrideProvider(AccessService)
      .useValue(mockAccessService)
      .compile();

    app = ref.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => app.close());

  beforeEach(() => {
    jest.clearAllMocks();
    mockAccessService.isModuleEnabled.mockResolvedValue(true);
    mockAccessService.resolveUserPermissions.mockResolvedValue(new Map<string, string>());
    mockOwnershipService.listModuleOwnerships.mockResolvedValue([stubOwnership]);
    mockOwnershipService.getModuleOwnership.mockResolvedValue(stubOwnership);
    mockOwnershipService.forceSetModuleOwner.mockResolvedValue({ success: true });
    mockOwnershipService.initiateOrgTransfer.mockResolvedValue(stubTransferResponse);
    mockOwnershipService.initiateModuleTransfer.mockResolvedValue(stubTransferResponse);
    mockOwnershipService.listTransfers.mockResolvedValue(stubListResponse);
    mockOwnershipService.acceptTransfer.mockResolvedValue({ success: true });
    mockOwnershipService.declineTransfer.mockResolvedValue({ success: true });
    mockOwnershipService.cancelTransfer.mockResolvedValue({ success: true });
  });

  type Method = "get" | "post" | "put" | "delete" | "patch";

  function callRoute(method: Method, path: string): request.Test {
    const agent = request(app.getHttpServer());
    switch (method) {
      case "get": return agent.get(path);
      case "post": return agent.post(path);
      case "put": return agent.put(path);
      case "delete": return agent.delete(path);
      case "patch": return agent.patch(path);
    }
  }

  const authedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/ownership/modules"],
    ["get", "/ownership/modules/hr"],
    ["put", "/ownership/modules/hr/owner"],
    ["post", "/ownership/org/transfer"],
    ["post", "/ownership/modules/hr/transfer"],
    ["get", "/ownership/transfers"],
    ["post", `/ownership/transfers/${TRANSFER_ID}/accept`],
    ["post", `/ownership/transfers/${TRANSFER_ID}/decline`],
    ["delete", `/ownership/transfers/${TRANSFER_ID}`],
  ];

  it.each(authedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  describe("Permission guard", () => {
    it("GET /ownership/modules → 403 when caller holds no permissions", async () => {
      const token = await signToken({ isOrgOwner: false, isPlatformAdmin: false });
      const res = await request(app.getHttpServer())
        .get("/ownership/modules")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("GET /ownership/transfers → 403 when caller holds no permissions", async () => {
      const token = await signToken({ isOrgOwner: false, isPlatformAdmin: false });
      const res = await request(app.getHttpServer())
        .get("/ownership/transfers")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("POST /ownership/transfers/:id/accept → 403 when caller lacks ownership:transfer:respond", async () => {
      const token = await signToken({ isOrgOwner: false, isPlatformAdmin: false });
      const res = await request(app.getHttpServer())
        .post(`/ownership/transfers/${TRANSFER_ID}/accept`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("DELETE /ownership/transfers/:id → 403 when caller lacks ownership:modules:manage", async () => {
      const token = await signToken({ isOrgOwner: false, isPlatformAdmin: false });
      const res = await request(app.getHttpServer())
        .delete(`/ownership/transfers/${TRANSFER_ID}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("GET /ownership/modules → 200 for org owner (bypasses permission guard)", async () => {
      const token = await signToken({ isOrgOwner: true });
      const res = await request(app.getHttpServer())
        .get("/ownership/modules")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it("GET /ownership/transfers → 200 for org owner (bypasses permission guard)", async () => {
      const token = await signToken({ isOrgOwner: true });
      const res = await request(app.getHttpServer())
        .get("/ownership/transfers")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ data: expect.any(Array) });
    });

    it("GET /ownership/modules → 200 for non-owner holding ownership:modules:view", async () => {
      mockAccessService.resolveUserPermissions.mockResolvedValue(
        new Map<string, string>([["ownership:modules:view", "all"]]),
      );
      const token = await signToken({ isOrgOwner: false, isPlatformAdmin: false });
      const res = await request(app.getHttpServer())
        .get("/ownership/modules")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    });
  });

  describe("Controller-level org-owner check (runs after PermissionGuard passes)", () => {
    it("POST /ownership/org/transfer → 403 when non-owner holds ownership:org:transfer permission", async () => {
      mockAccessService.resolveUserPermissions.mockResolvedValue(
        new Map<string, string>([["ownership:org:transfer", "all"]]),
      );
      const token = await signToken({ isOrgOwner: false, isPlatformAdmin: false });
      const res = await request(app.getHttpServer())
        .post("/ownership/org/transfer")
        .set("Authorization", `Bearer ${token}`)
        .send({ toMembershipId: 99 });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: expect.stringContaining("org owner") });
    });

    it("PUT /ownership/modules/hr/owner → 403 when non-owner holds ownership:modules:manage permission", async () => {
      mockAccessService.resolveUserPermissions.mockResolvedValue(
        new Map<string, string>([["ownership:modules:manage", "all"]]),
      );
      const token = await signToken({ isOrgOwner: false, isPlatformAdmin: false });
      const res = await request(app.getHttpServer())
        .put("/ownership/modules/hr/owner")
        .set("Authorization", `Bearer ${token}`)
        .send({ ownerMembershipId: 5 });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: expect.stringContaining("org owner") });
    });

    it("platform admin also passes controller-level check for org transfer", async () => {
      const token = await signToken({ isOrgOwner: false, isPlatformAdmin: true });
      const res = await request(app.getHttpServer())
        .post("/ownership/org/transfer")
        .set("Authorization", `Bearer ${token}`)
        .send({ toMembershipId: 99 });
      expect(res.status).toBe(201);
    });
  });

  describe("Service-level business-rule rejections propagate correctly", () => {
    it("POST /ownership/org/transfer → 400 when target membership is not ACTIVE", async () => {
      mockOwnershipService.initiateOrgTransfer.mockRejectedValue(
        new BadRequestException("Target membership must be ACTIVE to receive ownership"),
      );
      const token = await signToken({ isOrgOwner: true });
      const res = await request(app.getHttpServer())
        .post("/ownership/org/transfer")
        .set("Authorization", `Bearer ${token}`)
        .send({ toMembershipId: 99 });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: expect.stringContaining("ACTIVE") });
    });

    it("POST /ownership/org/transfer → 409 when a PENDING transfer already exists for this scope", async () => {
      mockOwnershipService.initiateOrgTransfer.mockRejectedValue(
        new ConflictException("A pending org ownership transfer already exists"),
      );
      const token = await signToken({ isOrgOwner: true });
      const res = await request(app.getHttpServer())
        .post("/ownership/org/transfer")
        .set("Authorization", `Bearer ${token}`)
        .send({ toMembershipId: 99 });
      expect(res.status).toBe(409);
    });

    it("POST /ownership/modules/hr/transfer → 409 when a PENDING module transfer already exists", async () => {
      mockAccessService.resolveUserPermissions.mockResolvedValue(
        new Map<string, string>([["ownership:modules:manage", "all"]]),
      );
      mockOwnershipService.initiateModuleTransfer.mockRejectedValue(
        new ConflictException(`A pending transfer for module "hr" already exists`),
      );
      const token = await signToken({ isOrgOwner: false, isPlatformAdmin: false });
      const res = await request(app.getHttpServer())
        .post("/ownership/modules/hr/transfer")
        .set("Authorization", `Bearer ${token}`)
        .send({ toMembershipId: 99 });
      expect(res.status).toBe(409);
    });

    it("POST /ownership/transfers/:id/accept → 403 when caller is not the designated recipient", async () => {
      mockAccessService.resolveUserPermissions.mockResolvedValue(
        new Map<string, string>([["ownership:transfer:respond", "all"]]),
      );
      mockOwnershipService.acceptTransfer.mockRejectedValue(
        new ForbiddenException("Only the designated recipient may accept this transfer"),
      );
      const token = await signToken({ isOrgOwner: false, isPlatformAdmin: false });
      const res = await request(app.getHttpServer())
        .post(`/ownership/transfers/${TRANSFER_ID}/accept`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: expect.stringContaining("recipient") });
    });

    it("POST /ownership/transfers/:id/accept → 400 when the initiator is no longer the org owner", async () => {
      mockAccessService.resolveUserPermissions.mockResolvedValue(
        new Map<string, string>([["ownership:transfer:respond", "all"]]),
      );
      mockOwnershipService.acceptTransfer.mockRejectedValue(
        new BadRequestException("Initiator is no longer the organization owner; transfer is invalid"),
      );
      const token = await signToken({ isOrgOwner: false, isPlatformAdmin: false });
      const res = await request(app.getHttpServer())
        .post(`/ownership/transfers/${TRANSFER_ID}/accept`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: expect.stringContaining("longer the organization owner") });
    });

    it("POST /ownership/transfers/:id/accept → 400 when the transfer has expired", async () => {
      mockAccessService.resolveUserPermissions.mockResolvedValue(
        new Map<string, string>([["ownership:transfer:respond", "all"]]),
      );
      mockOwnershipService.acceptTransfer.mockRejectedValue(
        new BadRequestException("Transfer has expired"),
      );
      const token = await signToken({ isOrgOwner: false, isPlatformAdmin: false });
      const res = await request(app.getHttpServer())
        .post(`/ownership/transfers/${TRANSFER_ID}/accept`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: expect.stringContaining("expired") });
    });

    it("PUT /ownership/modules/hr/owner → 200 when org owner force-reassigns a module owner", async () => {
      const token = await signToken({ isOrgOwner: true });
      const res = await request(app.getHttpServer())
        .put("/ownership/modules/hr/owner")
        .set("Authorization", `Bearer ${token}`)
        .send({ ownerMembershipId: 5 });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true });
    });

    it("PUT /ownership/modules/hr/owner → 400 when target membership is not ACTIVE (force-reassign path)", async () => {
      mockOwnershipService.forceSetModuleOwner.mockRejectedValue(
        new BadRequestException("Target membership must be ACTIVE to receive module ownership"),
      );
      const token = await signToken({ isOrgOwner: true });
      const res = await request(app.getHttpServer())
        .put("/ownership/modules/hr/owner")
        .set("Authorization", `Bearer ${token}`)
        .send({ ownerMembershipId: 99 });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: expect.stringContaining("ACTIVE") });
    });
  });

  describe("Cross-tenant isolation", () => {
    it("service always receives the orgId from the JWT, not from any request body", async () => {
      const ORG_A = "org-alpha-isolation";
      mockOwnershipService.forceSetModuleOwner.mockImplementation(
        (orgId: string) => {
          expect(orgId).toBe(ORG_A);
          return Promise.resolve({ success: true });
        },
      );
      const token = await signToken({ orgId: ORG_A, isOrgOwner: true });
      await request(app.getHttpServer())
        .put("/ownership/modules/hr/owner")
        .set("Authorization", `Bearer ${token}`)
        .send({ ownerMembershipId: 5 });
      expect(mockOwnershipService.forceSetModuleOwner).toHaveBeenCalledWith(
        ORG_A,
        expect.any(String),
        "hr",
        expect.anything(),
      );
    });

    it("listTransfers is scoped to the orgId in the JWT token", async () => {
      const ORG_A = "org-alpha-list";
      mockOwnershipService.listTransfers.mockImplementation(
        (orgId: string) => {
          expect(orgId).toBe(ORG_A);
          return Promise.resolve(stubListResponse);
        },
      );
      const token = await signToken({ orgId: ORG_A, isOrgOwner: true });
      const res = await request(app.getHttpServer())
        .get("/ownership/transfers")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(mockOwnershipService.listTransfers).toHaveBeenCalledWith(ORG_A, expect.anything());
    });

    it("acceptTransfer for a transfer that belongs to a different org → 404", async () => {
      mockAccessService.resolveUserPermissions.mockResolvedValue(
        new Map<string, string>([["ownership:transfer:respond", "all"]]),
      );
      mockOwnershipService.acceptTransfer.mockRejectedValue(
        new NotFoundException("Transfer not found"),
      );
      const token = await signToken({ orgId: "org-alpha", isOrgOwner: false, isPlatformAdmin: false });
      const res = await request(app.getHttpServer())
        .post(`/ownership/transfers/${TRANSFER_ID}/accept`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(404);
    });

    it("listModuleOwnerships is scoped to the orgId in the JWT token", async () => {
      const ORG_A = "org-alpha-mods";
      mockOwnershipService.listModuleOwnerships.mockImplementation(
        (orgId: string) => {
          expect(orgId).toBe(ORG_A);
          return Promise.resolve([]);
        },
      );
      const token = await signToken({ orgId: ORG_A, isOrgOwner: true });
      await request(app.getHttpServer())
        .get("/ownership/modules")
        .set("Authorization", `Bearer ${token}`);
      expect(mockOwnershipService.listModuleOwnerships).toHaveBeenCalledWith(ORG_A);
    });
  });

  describe("Input validation", () => {
    it("PUT /ownership/modules/hr/owner → 400 when ownerMembershipId is missing", async () => {
      const token = await signToken({ isOrgOwner: true });
      const res = await request(app.getHttpServer())
        .put("/ownership/modules/hr/owner")
        .set("Authorization", `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: expect.stringContaining("Validation failed") });
    });

    it("PUT /ownership/modules/hr/owner → 400 when ownerMembershipId is not a positive integer", async () => {
      const token = await signToken({ isOrgOwner: true });
      const res = await request(app.getHttpServer())
        .put("/ownership/modules/hr/owner")
        .set("Authorization", `Bearer ${token}`)
        .send({ ownerMembershipId: -5 });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: expect.stringContaining("Validation failed") });
    });

    it("POST /ownership/org/transfer → 400 when toMembershipId is not a positive integer", async () => {
      const token = await signToken({ isOrgOwner: true });
      const res = await request(app.getHttpServer())
        .post("/ownership/org/transfer")
        .set("Authorization", `Bearer ${token}`)
        .send({ toMembershipId: 0 });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: expect.stringContaining("Validation failed") });
    });

    it("POST /ownership/org/transfer → 400 when expiresInHours exceeds maximum", async () => {
      const token = await signToken({ isOrgOwner: true });
      const res = await request(app.getHttpServer())
        .post("/ownership/org/transfer")
        .set("Authorization", `Bearer ${token}`)
        .send({ toMembershipId: 1, expiresInHours: 999 });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: expect.stringContaining("Validation failed") });
    });
  });
});
