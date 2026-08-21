import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { ALL_MODULES, signToken } from "../../../test/helpers/sign-token";
import { AccessService } from "../access/access.service";
import { RolesService } from "./roles.service";
import type { DataScope } from "../access/access.types";

const TARGET_USER_ID = "user_target_1";

const SIMULATE_PERMISSIONS_MAP: Map<string, DataScope> = new Map([
  ["crm:leads:read", "all"],
  ["crm:leads:write", "own"],
  ["settings:rbac:manage", "none"],
]);

const MATRIX_RESPONSE = [
  {
    roleId: 1,
    roleName: "Admin",
    roleSlug: "admin",
    permissions: ["settings:rbac:manage", "crm:leads:read"],
  },
  {
    roleId: 2,
    roleName: "Sales",
    roleSlug: "sales",
    permissions: ["crm:leads:read", "crm:leads:write"],
  },
];

describe("Roles RBAC admin endpoints (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);

    const ref = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AccessService)
      .useValue({
        resolveUserPermissions: async (_orgId: string, _userId: string) =>
          SIMULATE_PERMISSIONS_MAP,
        isModuleEnabled: async (_orgId: string, _moduleKey: string) => true,
        getSnapshot: async () => ({
          permissions: ["settings:rbac:manage"],
          scopes: { "settings:rbac:manage": "all" },
          modules: {},
          isOrgOwner: false,
          version: 1,
        }),
      })
      .overrideProvider(RolesService)
      .useValue({
        getPermissionsMatrix: async (_orgId: string) => MATRIX_RESPONSE,
        getRoles: async () => [],
        listTemplates: () => [],
      })
      .compile();

    app = ref.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => app.close());

  describe("GET /roles/simulate/:targetUserId", () => {
    it("returns 401 when unauthenticated", async () => {
      const res = await request(app.getHttpServer()).get(
        `/roles/simulate/${TARGET_USER_ID}`,
      );
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "Unauthorized" });
    });

    it("returns 403 when the caller lacks settings:rbac:manage", async () => {
      const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
      const res = await request(app.getHttpServer())
        .get(`/roles/simulate/${TARGET_USER_ID}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: "Permission denied" });
    });

    it("returns 200 with resolved permissions for the target user when admin calls", async () => {
      const token = await signToken({
        permissions: ["settings:rbac:manage"],
        enabledModules: [],
      });
      const res = await request(app.getHttpServer())
        .get(`/roles/simulate/${TARGET_USER_ID}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        userId: TARGET_USER_ID,
        isOrgOwner: false,
      });
      expect(Array.isArray(res.body.permissions)).toBe(true);
      expect(typeof res.body.scopes).toBe("object");
    });

    it("excludes permissions with scope 'none' from the result", async () => {
      const token = await signToken({
        permissions: ["settings:rbac:manage"],
        enabledModules: [],
      });
      const res = await request(app.getHttpServer())
        .get(`/roles/simulate/${TARGET_USER_ID}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.permissions).not.toContain("settings:rbac:manage");
      expect(res.body.permissions).toContain("crm:leads:read");
      expect(res.body.permissions).toContain("crm:leads:write");
    });

    it("includes only non-none scopes in the scopes map", async () => {
      const token = await signToken({
        permissions: ["settings:rbac:manage"],
        enabledModules: [],
      });
      const res = await request(app.getHttpServer())
        .get(`/roles/simulate/${TARGET_USER_ID}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.scopes).not.toHaveProperty("settings:rbac:manage");
      expect(res.body.scopes).toMatchObject({
        "crm:leads:read": "all",
        "crm:leads:write": "own",
      });
    });
  });

  describe("GET /roles/permissions/matrix", () => {
    it("returns 401 when unauthenticated", async () => {
      const res = await request(app.getHttpServer()).get("/roles/permissions/matrix");
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "Unauthorized" });
    });

    it("returns 403 when the caller lacks settings:rbac:manage", async () => {
      const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
      const res = await request(app.getHttpServer())
        .get("/roles/permissions/matrix")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: "Permission denied" });
    });

    it("returns 200 with an array of roles and their permissions when admin calls", async () => {
      const token = await signToken({
        permissions: ["settings:rbac:manage"],
        enabledModules: [],
      });
      const res = await request(app.getHttpServer())
        .get("/roles/permissions/matrix")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(MATRIX_RESPONSE.length);
    });

    it("each matrix entry has the expected shape", async () => {
      const token = await signToken({
        permissions: ["settings:rbac:manage"],
        enabledModules: [],
      });
      const res = await request(app.getHttpServer())
        .get("/roles/permissions/matrix")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      for (const entry of res.body as typeof MATRIX_RESPONSE) {
        expect(typeof entry.roleId).toBe("number");
        expect(typeof entry.roleName).toBe("string");
        expect(typeof entry.roleSlug).toBe("string");
        expect(Array.isArray(entry.permissions)).toBe(true);
      }
    });

    it("returns the mocked matrix payload verbatim", async () => {
      const token = await signToken({
        permissions: ["settings:rbac:manage"],
        enabledModules: [],
      });
      const res = await request(app.getHttpServer())
        .get("/roles/permissions/matrix")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(MATRIX_RESPONSE);
    });
  });
});
