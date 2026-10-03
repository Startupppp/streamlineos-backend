import { Test, type TestingModule } from "@nestjs/testing";
import { type INestApplication, type CanActivate, type ExecutionContext } from "@nestjs/common";
import request from "supertest";
import { DiscoveryModule, Reflector } from "@nestjs/core";
import { PayrollForm16DocumentsController } from "./form16-documents.controller";
import { EssForm16Controller } from "../insights/ess-form16.controller";
import { Form16DocumentsService } from "./form16-documents.service";
import { AccessService } from "../../access/access.service";
import { PermissionGuard } from "../../access/permission.guard";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { moduleAvailabilityResolver } from "../../../common/rbac/module-availability";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { attachTestAuthContext } from "../../../../test/helpers/module-guard-context";
import { humanSessionPrincipal } from "../../../common/auth/principal";

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

function accessWith(scope: "none" | "all") {
  return {
    scopeFor: async () => scope,
    getModuleState: async () => true as const,
    buildModuleAvailabilityResolver: (getModuleMap: (orgId: string) => Promise<Record<string, boolean>>) =>
      moduleAvailabilityResolver(
        { isCoreModule: () => true, getModuleMap, getPlanLockedModules: async () => [] },
        { getUserDeniedModules: async () => new Set<string>() },
      ),
  };
}

const service = {
  list: jest.fn(),
  upload: jest.fn(),
  release: jest.fn(),
  releaseAll: jest.fn(),
  download: jest.fn(),
  listOwn: jest.fn(async () => ({ documents: [] })),
  downloadOwn: jest.fn(),
};

async function buildApp(scope: "none" | "all"): Promise<INestApplication> {
  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [DiscoveryModule],
    controllers: [PayrollForm16DocumentsController, EssForm16Controller],
    providers: [
      { provide: Form16DocumentsService, useValue: service },
      { provide: AccessService, useValue: accessWith(scope) },
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

describe("Form 16 routes — permission guard deny", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildApp("none");
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /payroll/form16 is denied without payroll:tax:view (403)", async () => {
    const res = await request(app.getHttpServer()).get("/payroll/form16?financialYear=2025-26");
    expect(res.status).toBe(403);
  });

  it("POST /payroll/form16/*/release-all is denied without payroll:tax:manage (403)", async () => {
    const fy = "2025-26";
    const res = await request(app.getHttpServer()).post(`/payroll/form16/${fy}/release-all`);
    expect(res.status).toBe(403);
  });

  it("POST /payroll/form16/*/members/*/upload is denied without payroll:tax:manage (403)", async () => {
    const fy = "2025-26";
    const membershipId = 7;
    const res = await request(app.getHttpServer()).post(`/payroll/form16/${fy}/members/${membershipId}/upload`);
    expect(res.status).toBe(403);
  });

  it("POST /payroll/form16/*/members/*/release is denied without payroll:tax:manage (403)", async () => {
    const fy = "2025-26";
    const membershipId = 7;
    const res = await request(app.getHttpServer()).post(`/payroll/form16/${fy}/members/${membershipId}/release`);
    expect(res.status).toBe(403);
  });

  it("GET /payroll/form16/*/members/*/download is denied without payroll:tax:view (403)", async () => {
    const fy = "2025-26";
    const membershipId = 7;
    const res = await request(app.getHttpServer()).get(`/payroll/form16/${fy}/members/${membershipId}/download`);
    expect(res.status).toBe(403);
  });

  it("GET /payroll/me/form16 is denied without self:payslips (403)", async () => {
    const res = await request(app.getHttpServer()).get("/payroll/me/form16");
    expect(res.status).toBe(403);
  });

  it("GET /payroll/me/form16/*/download is denied without self:payslips (403)", async () => {
    const fy = "2025-26";
    const res = await request(app.getHttpServer()).get(`/payroll/me/form16/${fy}/download`);
    expect(res.status).toBe(403);
    expect(service.downloadOwn).not.toHaveBeenCalled();
  });
});

describe("Form 16 routes — allowed caller", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildApp("all");
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /payroll/me/form16 reaches the service with the caller's own membership", async () => {
    const res = await request(app.getHttpServer()).get("/payroll/me/form16");
    expect(res.status).toBe(200);
    expect(service.listOwn).toHaveBeenCalledWith("org1", 1);
  });
});
