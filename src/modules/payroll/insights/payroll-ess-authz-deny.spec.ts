import { Test, type TestingModule } from "@nestjs/testing";
import { type INestApplication, type CanActivate, type ExecutionContext } from "@nestjs/common";
import request from "supertest";
import { Reflector } from "@nestjs/core";
import { EssController } from "./ess.controller";
import { EssService } from "./ess.service";
import { EssSelfServiceService } from "./ess-self-service.service";
import { AccessService } from "../../access/access.service";
import { PermissionGuard } from "../../access/permission.guard";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
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
    controllers: [EssController],
    providers: [
      {
        provide: EssService,
        useValue: {
          getOverview: jest.fn(), getPayslips: jest.fn(),
          getSalaryStructure: jest.fn(), getOwnFnf: jest.fn(), getTotalRewards: jest.fn(),
        },
      },
      {
        provide: EssSelfServiceService,
        useValue: {
          listReimbursements: jest.fn(), createReimbursement: jest.fn(),
          listLoans: jest.fn(), createLoan: jest.fn(),
          getTaxDeclaration: jest.fn(), submitTaxDeclaration: jest.fn(), addTaxProof: jest.fn(),
          getBankDetails: jest.fn(), updateBankDetails: jest.fn(),
        },
      },
      { provide: AccessService, useValue: denyAll },
      Reflector,
      PermissionGuard,
    ],
  })
    .overrideGuard(JwtAuthGuard)
    .useClass(HeaderAuthGuard)
    .compile();

  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

const ESS_GET_ROUTES: readonly string[] = [
  "/payroll/me/overview",
  "/payroll/me/payslips",
  "/payroll/me/salary-structure",
  "/payroll/me/reimbursements",
  "/payroll/me/loans",
  "/payroll/me/tax-declaration",
  "/payroll/me/bank",
  "/payroll/me/fnf",
  "/payroll/me/total-rewards",
];

const ESS_POST_ROUTES: readonly string[] = [
  "/payroll/me/reimbursements",
  "/payroll/me/loans",
  "/payroll/me/tax-declaration",
  "/payroll/me/tax-declaration/proofs",
];

describe("EssController — payroll employee self-service permission deny", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it.each(ESS_GET_ROUTES)("GET %s is denied without self:payroll permission (403)", async (path) => {
    const res = await request(app.getHttpServer()).get(path).set("Authorization", "Bearer token");
    expect(res.status).toBe(403);
  });

  it.each(ESS_POST_ROUTES)("POST %s is denied without self:payroll permission (403)", async (path) => {
    const res = await request(app.getHttpServer()).post(path).set("Authorization", "Bearer token").send({});
    expect(res.status).toBe(403);
  });

  it("PATCH /payroll/me/bank is denied without self:payroll permission (403)", async () => {
    const res = await request(app.getHttpServer()).patch("/payroll/me/bank").set("Authorization", "Bearer token").send({});
    expect(res.status).toBe(403);
  });
});
