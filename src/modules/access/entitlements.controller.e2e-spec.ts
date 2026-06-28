import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { signToken } from "../../../test/helpers/sign-token";
import { EntitlementsService } from "./entitlements.service";
import { AccessService } from "./access.service";

const RBAC_E2E_DATABASE_URL = process.env.RBAC_E2E_DATABASE_URL;
const describeWithDb = RBAC_E2E_DATABASE_URL ? describe : describe.skip;

const mockModules: Array<{ moduleKey: string; enabled: boolean }> = [
  { moduleKey: "crm", enabled: true },
  { moduleKey: "hr", enabled: false },
];

const mockEntitlementsService = {
  listModules: jest.fn().mockResolvedValue(mockModules),
  setModuleEnabled: jest.fn().mockResolvedValue(undefined),
  isModuleEnabled: jest.fn().mockResolvedValue(true),
  enabledModules: jest.fn().mockResolvedValue(["crm"]),
};

const mockAccessService = {
  resolveUserPermissions: jest.fn().mockResolvedValue(new Map([["settings:manage", "all"]])),
  isModuleEnabled: jest.fn().mockResolvedValue(true),
};

describeWithDb("Entitlements controller auth/RBAC (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);

    const ref = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EntitlementsService)
      .useValue(mockEntitlementsService)
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
    mockEntitlementsService.listModules.mockResolvedValue(mockModules);
    mockEntitlementsService.setModuleEnabled.mockResolvedValue(undefined);
    mockAccessService.resolveUserPermissions.mockResolvedValue(
      new Map([["settings:manage", "all"]]),
    );
  });

  it("GET /access/org-modules → 401 when unauthenticated", async () => {
    const res = await request(app.getHttpServer()).get("/access/org-modules");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("GET /access/org-modules → 403 when authenticated but lacks settings:manage", async () => {
    mockAccessService.resolveUserPermissions.mockResolvedValue(new Map());
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/access/org-modules")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Permission denied" });
  });

  it("GET /access/org-modules → 200 with modules array for admin user", async () => {
    const token = await signToken({
      permissions: ["settings:manage"],
      enabledModules: [],
      isOrgOwner: true,
    });
    const res = await request(app.getHttpServer())
      .get("/access/org-modules")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toEqual(mockModules);
    expect(mockEntitlementsService.listModules).toHaveBeenCalledTimes(1);
  });

  it("PATCH /access/org-modules/crm → 204 when toggling module", async () => {
    const token = await signToken({
      permissions: ["settings:manage"],
      enabledModules: [],
      isOrgOwner: true,
    });
    const res = await request(app.getHttpServer())
      .patch("/access/org-modules/crm")
      .set("Authorization", `Bearer ${token}`)
      .send({ enabled: true });
    expect(res.status).toBe(204);
    expect(mockEntitlementsService.setModuleEnabled).toHaveBeenCalledTimes(1);
  });

  it("PATCH /access/org-modules/crm → 400 with invalid body (missing enabled)", async () => {
    const token = await signToken({
      permissions: ["settings:manage"],
      enabledModules: [],
      isOrgOwner: true,
    });
    const res = await request(app.getHttpServer())
      .patch("/access/org-modules/crm")
      .set("Authorization", `Bearer ${token}`)
      .send({ enabled: "not-a-boolean" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining("Validation failed") });
  });

  it("PATCH /access/org-modules/invalid key! → 400 due to moduleKey regex failure", async () => {
    const token = await signToken({
      permissions: ["settings:manage"],
      enabledModules: [],
      isOrgOwner: true,
    });
    const res = await request(app.getHttpServer())
      .patch("/access/org-modules/invalid%20key!")
      .set("Authorization", `Bearer ${token}`)
      .send({ enabled: true });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining("Validation failed") });
  });
});
