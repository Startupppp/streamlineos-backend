import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { signToken } from "../../../test/helpers/sign-token";
import { AccessService } from "../../modules/access/access.service";
import { ResourceGrantsService } from "../../modules/access/resource-grants.service";

const RBAC_E2E_DATABASE_URL = process.env.RBAC_E2E_DATABASE_URL;

const mockGrant = {
  id: "grant-uuid-1",
  orgId: "org_1",
  resourceType: "kb:space",
  resourceId: "space-1",
  principalType: "user" as const,
  principalId: "user-uuid-1",
  permissionKey: "kb:space:read",
  grantedBy: "user_1",
  createdAt: new Date().toISOString(),
};

const permittedAccessService = {
  resolveUserPermissions: async () => new Map([["settings:rbac:manage", "all"]]),
  isModuleEnabled: async (_orgId: string, _moduleKey: string) => true,
};

const forbiddenAccessService = {
  resolveUserPermissions: async () => new Map<string, string>(),
  isModuleEnabled: async (_orgId: string, _moduleKey: string) => true,
};

const mockResourceGrantsService = {
  listGrants: jest.fn().mockResolvedValue([mockGrant]),
  grant: jest.fn().mockResolvedValue(mockGrant),
  revoke: jest.fn().mockResolvedValue({ success: true }),
};

describe("ResourceGrants auth/RBAC (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);

    const ref = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AccessService)
      .useValue(permittedAccessService)
      .overrideProvider(ResourceGrantsService)
      .useValue(mockResourceGrantsService)
      .compile();

    app = ref.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => app.close());

  const protectedRoutes: ReadonlyArray<["get" | "post" | "delete", string]> = [
    ["get", "/access/resource-grants?resourceType=kb:space&resourceId=space-1"],
    ["post", "/access/resource-grants"],
    ["delete", "/access/resource-grants/grant-uuid-1"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const agent = request(app.getHttpServer());
    const res = await agent[method](path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("GET /access/resource-grants returns 200 with array when permitted", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/access/resource-grants?resourceType=kb:space&resourceId=space-1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("POST /access/resource-grants returns 201 with created grant when permitted", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/access/resource-grants")
      .set("Authorization", `Bearer ${token}`)
      .send({
        resourceType: "kb:space",
        resourceId: "space-1",
        principalType: "user",
        principalId: "user-uuid-1",
        permissionKey: "kb:space:read",
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      resourceType: "kb:space",
      resourceId: "space-1",
      principalType: "user",
    });
  });

  it("POST /access/resource-grants returns 400 when body is missing required fields", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/access/resource-grants")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining("Validation failed") });
  });

  it("DELETE /access/resource-grants/:grantId returns 200 with { success: true } when permitted", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .delete("/access/resource-grants/grant-uuid-1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });
});

const describeWithDb = RBAC_E2E_DATABASE_URL ? describe : describe.skip;

describeWithDb("ResourceGrants 403 when permission is none (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);

    const ref = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AccessService)
      .useValue(forbiddenAccessService)
      .overrideProvider(ResourceGrantsService)
      .useValue(mockResourceGrantsService)
      .compile();

    app = ref.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => app.close());

  it("GET /access/resource-grants returns 403 when permission map is empty", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/access/resource-grants?resourceType=kb:space&resourceId=space-1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Permission denied" });
  });

  it("POST /access/resource-grants returns 403 when permission map is empty", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/access/resource-grants")
      .set("Authorization", `Bearer ${token}`)
      .send({
        resourceType: "kb:space",
        resourceId: "space-1",
        principalType: "user",
        principalId: "user-uuid-1",
        permissionKey: "kb:space:read",
      });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Permission denied" });
  });

  it("DELETE /access/resource-grants/:grantId returns 403 when permission map is empty", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .delete("/access/resource-grants/grant-uuid-1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Permission denied" });
  });
});
