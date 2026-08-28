import type { INestApplication } from "@nestjs/common";
import { ConflictException, NotFoundException } from "@nestjs/common";
import request from "supertest";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { createE2eApp } from "test/helpers/e2e-app";
import { AccessService } from "../../access/access.service";
import { EntitlementsService } from "../../access/entitlements.service";
import { PayrollTemplatesService, seedPayrollTemplates } from "./templates.service";
import { PayrollPoliciesService } from "./policies.service";
import { PayrollComponentsService } from "./components.service";
import { withAccessResolution } from "../../../../test/helpers/access-stub";

const ALL_PAYROLL_SETUP_PERMS = new Map([
  ["payroll:templates:view", "all"],
  ["payroll:templates:manage", "all"],
  ["payroll:policies:view", "all"],
  ["payroll:policies:manage", "all"],
  ["payroll:components:view", "all"],
  ["payroll:components:manage", "all"],
]);

const permittedAccess = withAccessResolution({
  resolveUserPermissions: jest.fn().mockResolvedValue(ALL_PAYROLL_SETUP_PERMS),
  isModuleEnabled: jest.fn().mockResolvedValue(true),
  moduleAvailability: async (): Promise<{ available: true }> => ({ available: true }),
});

const forbiddenAccess = withAccessResolution({
  resolveUserPermissions: jest.fn().mockResolvedValue(new Map()),
  isModuleEnabled: jest.fn().mockResolvedValue(true),
  moduleAvailability: async (): Promise<{ available: true }> => ({ available: true }),
});

const mockTemplate = { id: 1, key: "INDIAN_STANDARD", name: "Indian Standard", category: "EMPLOYEE", isRecommended: true };
const mockPolicy = { id: 1, orgId: "org_1", country: "IN", currency: "INR", status: "DRAFT" };
const mockComponent = { id: 1, orgId: "org_1", code: "BASIC", name: "Basic", type: "EARNING" };
const mockPreview = { lines: [], totals: { gross: "0.00", deductions: "0.00", net: "0.00", employerContributions: "0.00" } };

const mockTemplatesService = {
  list: jest.fn().mockResolvedValue({ items: [mockTemplate], total: 1 }),
  getById: jest.fn().mockResolvedValue(mockTemplate),
  preview: jest.fn().mockResolvedValue(mockPreview),
  duplicate: jest.fn().mockResolvedValue({ id: 2, name: "Copy" }),
  deleteCustomTemplate: jest.fn().mockResolvedValue({ success: true }),
};

const mockPoliciesService = {
  getCurrent: jest.fn().mockResolvedValue(mockPolicy),
  toggleImpact: jest.fn().mockResolvedValue({ impactedEmployees: 0, components: [] }),
  create: jest.fn().mockResolvedValue(mockPolicy),
  preview: jest.fn().mockResolvedValue(mockPreview),
  update: jest.fn().mockResolvedValue(mockPolicy),
  activate: jest.fn().mockResolvedValue({ policyId: 1, versionId: 1, checklist: [] }),
  listVersions: jest.fn().mockResolvedValue([]),
  createVersion: jest.fn().mockResolvedValue({ versionId: 2 }),
};

const mockComponentsService = {
  list: jest.fn().mockResolvedValue({ items: [mockComponent], total: 1 }),
  create: jest.fn().mockResolvedValue(mockComponent),
  update: jest.fn().mockResolvedValue(mockComponent),
  remove: jest.fn().mockResolvedValue({ ok: true }),
};

const alwaysOnEntitlements = {
  isModuleEnabled: async (): Promise<boolean> => true,
  moduleAvailability: async (): Promise<{ available: true }> => ({ available: true }),
  getModuleMap: async (): Promise<Record<string, boolean>> => ({}),
  getEffectiveModuleMap: async (): Promise<Record<string, boolean>> => ({}),
};

type Method = "get" | "post" | "patch" | "delete";
const protectedRoutes: ReadonlyArray<[Method, string]> = [
  ["get", "/payroll/templates"],
  ["get", "/payroll/templates/1"],
  ["post", "/payroll/templates/1/duplicate"],
  ["post", "/payroll/templates/1/preview"],
  ["delete", "/payroll/templates/1"],
  ["get", "/payroll/policies/current"],
  ["get", "/payroll/policies/toggle-impact"],
  ["post", "/payroll/policies"],
  ["post", "/payroll/policies/preview"],
  ["patch", "/payroll/policies/1"],
  ["post", "/payroll/policies/1/activate"],
  ["get", "/payroll/policies/1/versions"],
  ["post", "/payroll/policies/1/versions"],
  ["get", "/payroll/components"],
  ["post", "/payroll/components"],
  ["patch", "/payroll/components/1"],
  ["delete", "/payroll/components/1"],
];

async function buildApp(accessMock: typeof permittedAccess): Promise<INestApplication> {
  return createE2eApp({
    overrides: [
      { provide: AccessService, useValue: accessMock },
      { provide: EntitlementsService, useValue: alwaysOnEntitlements },
      { provide: PayrollTemplatesService, useValue: mockTemplatesService },
      { provide: PayrollPoliciesService, useValue: mockPoliciesService },
      { provide: PayrollComponentsService, useValue: mockComponentsService },
    ],
  });
}

describe("payroll-setup auth/RBAC — 401 (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await buildApp(permittedAccess); });
  afterAll(async () => app.close());

  it.each(protectedRoutes)("401 on %s %s without token", async (method, path) => {
    const res = await request(app.getHttpServer())[method](path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });
});

describe("payroll-setup RBAC — 403 when no permissions (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await buildApp(forbiddenAccess); });
  afterAll(async () => app.close());

  const rbacRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/payroll/templates"],
    ["get", "/payroll/templates/1"],
    ["post", "/payroll/templates/1/duplicate"],
    ["post", "/payroll/templates/1/preview"],
    ["delete", "/payroll/templates/1"],
    ["get", "/payroll/policies/current"],
    ["post", "/payroll/policies"],
    ["post", "/payroll/policies/preview"],
    ["patch", "/payroll/policies/1"],
    ["post", "/payroll/policies/1/activate"],
    ["get", "/payroll/policies/1/versions"],
    ["post", "/payroll/policies/1/versions"],
    ["get", "/payroll/components"],
    ["post", "/payroll/components"],
    ["patch", "/payroll/components/1"],
    ["delete", "/payroll/components/1"],
  ];

  it.each(rbacRoutes)("403 on %s %s with empty permission map", async (method, path) => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())[method](path)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });
});

describe("payroll-setup RBAC — 200 view routes with view permission (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await buildApp(permittedAccess); });
  afterAll(async () => app.close());

  it("GET /payroll/templates → 200", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/templates")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("GET /payroll/templates/1 → 200", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/templates/1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("POST /payroll/templates/1/preview → 201 with valid body", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/payroll/templates/1/preview")
      .set("Authorization", `Bearer ${token}`)
      .send({ annualCtc: 1200000 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ lines: expect.any(Array), totals: expect.any(Object) });
  });

  it("GET /payroll/policies/current → 200", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/policies/current")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("GET /payroll/policies/toggle-impact → 200 with valid toggle param", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/policies/toggle-impact?toggle=pf")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("GET /payroll/components → 200", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/components")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("POST /payroll/templates/1/duplicate → 200 with valid body", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/payroll/templates/1/duplicate")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "My Template Copy" });
    expect(res.status).toBe(201);
  });

  it("POST /payroll/policies → 200 with valid body", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/payroll/policies")
      .set("Authorization", `Bearer ${token}`)
      .send({ startMonth: "2026-01" });
    expect(res.status).toBe(201);
  });
});

describe("payroll-setup RBAC — view-only caller blocked from manage routes (e2e)", () => {
  let app: INestApplication;

  const viewOnlyAccess = withAccessResolution({
    resolveUserPermissions: jest.fn().mockResolvedValue(new Map([
      ["payroll:templates:view", "all"],
      ["payroll:policies:view", "all"],
      ["payroll:components:view", "all"],
    ])),
    isModuleEnabled: jest.fn().mockResolvedValue(true),
    moduleAvailability: async (): Promise<{ available: true }> => ({ available: true }),
  });

  beforeAll(async () => { app = await buildApp(viewOnlyAccess); });
  afterAll(async () => app.close());

  it("POST /payroll/templates/1/duplicate → 403 for view-only caller", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/payroll/templates/1/duplicate")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Copy" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("POST /payroll/policies/1/activate → 403 for view-only caller", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/payroll/policies/1/activate")
      .set("Authorization", `Bearer ${token}`)
      .send({ templateKey: "INDIAN_STANDARD" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("POST /payroll/components → 403 for view-only caller", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/payroll/components")
      .set("Authorization", `Bearer ${token}`)
      .send({ code: "BONUS", name: "Bonus", type: "EARNING", calcMethod: "FIXED" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("DELETE /payroll/components/1 → 403 for view-only caller", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .delete("/payroll/components/1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("DELETE /payroll/templates/1 → 403 for view-only caller", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .delete("/payroll/templates/1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });
});

describe("payroll-setup — template delete (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await buildApp(permittedAccess); });
  afterAll(async () => app.close());

  it("DELETE /payroll/templates/1 → 204 success for custom template", async () => {
    mockTemplatesService.deleteCustomTemplate.mockResolvedValueOnce({ success: true });
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .delete("/payroll/templates/1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(204);
  });

  it("DELETE /payroll/templates/1 → 409 when service rejects system template", async () => {
    mockTemplatesService.deleteCustomTemplate.mockRejectedValueOnce(new ConflictException("Cannot delete system templates"));
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .delete("/payroll/templates/1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(409);
  });

  it("DELETE /payroll/templates/99 → 404 when template not found", async () => {
    mockTemplatesService.deleteCustomTemplate.mockRejectedValueOnce(new NotFoundException("Custom template not found"));
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .delete("/payroll/templates/99")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe("payroll-setup — complexity filter (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => { app = await buildApp(permittedAccess); });
  afterAll(async () => app.close());

  it("GET /payroll/templates?complexity=SIMPLE → 200 passes complexity to service", async () => {
    mockTemplatesService.list.mockResolvedValueOnce({ items: [], total: 0 });
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/templates?complexity=SIMPLE")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(mockTemplatesService.list).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ complexity: "SIMPLE" }),
    );
  });

  it("GET /payroll/templates?complexity=INVALID → 400 for invalid complexity", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/payroll/templates?complexity=INVALID")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});

describe("payroll-setup — seedPayrollTemplates idempotency (unit)", () => {
  it("calling seedPayrollTemplates twice returns seeded=0 the second time", async () => {
    const insertedKeys = new Set<string>();
    const mockDb = {
      query: {
        payrollTemplates: {
          findFirst: jest.fn(({ where: _where }: { where: unknown }): Promise<{ id: number } | null> => {
            return Promise.resolve(null);
          }),
        },
      },
      insert: jest.fn(() => ({
        values: jest.fn((vals: { key: string }) => {
          insertedKeys.add(vals.key);
          return Promise.resolve();
        }),
      })),
    };

    const findFirstImpl = ({ where: _where }: { where: unknown }) => {
      return Promise.resolve(null);
    };
    const findFirstImplSecond = ({ where: _where }: { where: unknown }) => {
      return Promise.resolve({ id: 1 });
    };

    mockDb.query.payrollTemplates.findFirst
      .mockImplementation(findFirstImpl);

    const first = await seedPayrollTemplates(mockDb as unknown as Parameters<typeof seedPayrollTemplates>[0]);
    expect(first.seeded).toBeGreaterThan(0);
    expect(first.skipped).toBe(0);

    mockDb.query.payrollTemplates.findFirst
      .mockImplementation(findFirstImplSecond);

    const second = await seedPayrollTemplates(mockDb as unknown as Parameters<typeof seedPayrollTemplates>[0]);
    expect(second.seeded).toBe(0);
    expect(second.skipped).toBeGreaterThan(0);
  });
});
