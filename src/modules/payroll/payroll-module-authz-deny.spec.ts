import { Test, type TestingModule } from "@nestjs/testing";
import { type INestApplication, type CanActivate, type ExecutionContext } from "@nestjs/common";
import request from "supertest";
import { Reflector } from "@nestjs/core";
import { AccountingMappingsController } from "./insights/accounting-mappings.controller";
import { AccountingMappingsService } from "./insights/accounting-mappings.service";
import { PayrollEntitiesController } from "./entities/entities.controller";
import { PayrollEntitiesService } from "./entities/entities.service";
import { PayrollJobsController } from "./jobs/jobs.controller";
import { PayrollJobsService } from "./jobs/payroll-jobs.service";
import { PayrollJobsWorkerService } from "./jobs/payroll-jobs-worker.service";
import { PayrollReadinessController } from "./runs/readiness.controller";
import { PayrollReadinessService } from "./runs/readiness.service";
import { AccessService } from "../access/access.service";
import { PermissionGuard } from "../access/permission.guard";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { moduleAvailabilityResolver } from "../../common/rbac/module-availability";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { attachTestAuthContext } from "../../../test/helpers/module-guard-context";
import { humanSessionPrincipal } from "../../common/auth/principal";

const USER_CTX: CurrentUserContext = {
  userId: "u1",
  orgId: "org1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "sess1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

class HeaderAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    attachTestAuthContext(ctx.switchToHttp().getRequest(), USER_CTX);
    return true;
  }
}

const denyAll = {
  scopeFor: async (_u: CurrentUserContext, _k: string) => "none" as const,
  getModuleState: async () => true as const,
  buildModuleAvailabilityResolver: (getModuleMap: (orgId: string) => Promise<Record<string, boolean>>) =>
    moduleAvailabilityResolver(
      { isCoreModule: () => true, getModuleMap, getPlanLockedModules: async () => [] },
      { getUserDeniedModules: async () => new Set<string>() },
    ),
};

async function buildApp(): Promise<INestApplication> {
  const moduleRef: TestingModule = await Test.createTestingModule({
    controllers: [AccountingMappingsController, PayrollEntitiesController, PayrollJobsController, PayrollReadinessController],
    providers: [
      { provide: AccountingMappingsService, useValue: { list: jest.fn(), create: jest.fn(), update: jest.fn(), remove: jest.fn() } },
      { provide: PayrollEntitiesService, useValue: { list: jest.fn(), listCountryPacks: jest.fn(), getEntity: jest.fn(), getEntityContext: jest.fn(), create: jest.fn() } },
      { provide: PayrollJobsService, useValue: { listFailed: jest.fn(), listForResource: jest.fn(), get: jest.fn(), enqueue: jest.fn(), retry: jest.fn() } },
      { provide: PayrollJobsWorkerService, useValue: { flush: jest.fn() } },
      { provide: PayrollReadinessService, useValue: { getReadiness: jest.fn() } },
      { provide: AccessService, useValue: denyAll },
      Reflector,
      PermissionGuard,
    ],
  })
    .overrideGuard(JwtAuthGuard)
    .useClass(HeaderAuthGuard)
    .overrideGuard(ModuleGuard)
    .useValue({ canActivate: () => true })
    .compile();

  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe("Payroll module controllers — permission guard deny", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("AccountingMappingsController — payroll:settings:manage required", () => {
    it("GET /payroll/accounting-mappings is denied without payroll:settings:manage (403)", async () => {
      const res = await request(app.getHttpServer()).get("/payroll/accounting-mappings").set("Authorization", "Bearer token");
      expect(res.status).toBe(403);
    });

    it("POST /payroll/accounting-mappings is denied without payroll:settings:manage (403)", async () => {
      const res = await request(app.getHttpServer()).post("/payroll/accounting-mappings").set("Authorization", "Bearer token").send({});
      expect(res.status).toBe(403);
    });

    it("PATCH /payroll/accounting-mappings/* is denied without payroll:settings:manage (403)", async () => {
      const mappingId = 1;
      const res = await request(app.getHttpServer()).patch(`/payroll/accounting-mappings/${mappingId}`).set("Authorization", "Bearer token").send({});
      expect(res.status).toBe(403);
    });

    it("DELETE /payroll/accounting-mappings/* is denied without payroll:settings:manage (403)", async () => {
      const mappingId = 1;
      const res = await request(app.getHttpServer()).delete(`/payroll/accounting-mappings/${mappingId}`).set("Authorization", "Bearer token");
      expect(res.status).toBe(403);
    });
  });

  describe("PayrollEntitiesController — payroll:policies:view/manage required", () => {
    it("GET /payroll/entities is denied without payroll:policies:view (403)", async () => {
      const res = await request(app.getHttpServer()).get("/payroll/entities").set("Authorization", "Bearer token");
      expect(res.status).toBe(403);
    });

    it("GET /payroll/entities/country-packs is denied without payroll:policies:view (403)", async () => {
      const res = await request(app.getHttpServer()).get("/payroll/entities/country-packs").set("Authorization", "Bearer token");
      expect(res.status).toBe(403);
    });

    it("GET /payroll/entities/*/context is denied without payroll:policies:view (403)", async () => {
      const entityId = 1;
      const res = await request(app.getHttpServer()).get(`/payroll/entities/${entityId}/context`).set("Authorization", "Bearer token");
      expect(res.status).toBe(403);
    });

    it("GET /payroll/entities/* is denied without payroll:policies:view (403)", async () => {
      const entityId = 1;
      const res = await request(app.getHttpServer()).get(`/payroll/entities/${entityId}`).set("Authorization", "Bearer token");
      expect(res.status).toBe(403);
    });

    it("POST /payroll/entities is denied without payroll:policies:manage (403)", async () => {
      const res = await request(app.getHttpServer()).post("/payroll/entities").set("Authorization", "Bearer token").send({});
      expect(res.status).toBe(403);
    });
  });

  describe("PayrollReadinessController — payroll:runs:view required", () => {
    it("GET /payroll/readiness is denied without payroll:runs:view (403)", async () => {
      const res = await request(app.getHttpServer()).get("/payroll/readiness?month=2026-09").set("Authorization", "Bearer token");
      expect(res.status).toBe(403);
    });
  });

  describe("PayrollJobsController — payroll:runs:view/manage required", () => {
    it("GET /payroll/jobs is denied without payroll:runs:view (403)", async () => {
      const res = await request(app.getHttpServer()).get("/payroll/jobs").set("Authorization", "Bearer token");
      expect(res.status).toBe(403);
    });

    it("GET /payroll/jobs/* is denied without payroll:runs:view (403)", async () => {
      const jobId = 1;
      const res = await request(app.getHttpServer()).get(`/payroll/jobs/${jobId}`).set("Authorization", "Bearer token");
      expect(res.status).toBe(403);
    });

    it("POST /payroll/jobs is denied without payroll:runs:manage (403)", async () => {
      const res = await request(app.getHttpServer()).post("/payroll/jobs").set("Authorization", "Bearer token").send({});
      expect(res.status).toBe(403);
    });

    it("POST /payroll/jobs/*/retry is denied without payroll:runs:manage (403)", async () => {
      const jobId = 1;
      const res = await request(app.getHttpServer()).post(`/payroll/jobs/${jobId}/retry`).set("Authorization", "Bearer token");
      expect(res.status).toBe(403);
    });
  });
});
