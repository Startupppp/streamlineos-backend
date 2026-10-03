import { Test, type TestingModule } from "@nestjs/testing";
import { type INestApplication, type CanActivate, type ExecutionContext } from "@nestjs/common";
import request from "supertest";
import { DiscoveryModule, Reflector } from "@nestjs/core";
import { HrPayrollFnfController } from "./fnf.controller";
import { FnfService } from "./fnf.service";
import {
  FnfSuggestionService,
  GRATUITY_CAP_MINOR,
  completedService,
  gratuityMinor,
  leaveEncashmentMinor,
} from "./fnf-suggestion.service";
import { AccessService } from "../../access/access.service";
import { PermissionGuard } from "../../access/permission.guard";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { moduleAvailabilityResolver } from "../../../common/rbac/module-availability";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { attachTestAuthContext } from "../../../../test/helpers/module-guard-context";
import { humanSessionPrincipal } from "../../../common/auth/principal";

describe("F&F gratuity under the Payment of Gratuity Act", () => {
  it("pays nothing at 4 years 11 months, even though the months would round up", () => {
    const service = completedService("2021-03-01", "2026-02-28");
    expect(service).toEqual({ years: 4, months: 11 });
    expect(gratuityMinor(30_000_00, service)).toEqual({ eligible: false, countedYears: 5, amountMinor: 0, capped: false });
  });

  it("counts 5 years 7 months as 6 years: 15/26 x basic x 6", () => {
    const service = completedService("2020-07-15", "2026-02-20");
    expect(service).toEqual({ years: 5, months: 7 });
    const result = gratuityMinor(26_000_00, service);
    expect(result).toEqual({ eligible: true, countedYears: 6, amountMinor: 90_000_00, capped: false });
  });

  it("does not round 5 years 5 months up", () => {
    expect(gratuityMinor(26_000_00, { years: 5, months: 5 }).amountMinor).toBe(75_000_00);
  });

  it("caps gratuity at 20 lakh rupees", () => {
    const result = gratuityMinor(5_00_000_00, { years: 30, months: 0 });
    expect(result.capped).toBe(true);
    expect(result.amountMinor).toBe(GRATUITY_CAP_MINOR);
    expect(GRATUITY_CAP_MINOR).toBe(2_000_000 * 100);
  });

  it("encashes leave at basic/26 per day", () => {
    expect(leaveEncashmentMinor(26_000_00, 12.5)).toBe(12_500_00);
  });
});

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

describe("GET /hr/fnf/suggestion — permission guard deny", () => {
  let app: INestApplication;
  const suggest = jest.fn();

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [DiscoveryModule],
      controllers: [HrPayrollFnfController],
      providers: [
        { provide: FnfService, useValue: {} },
        { provide: FnfSuggestionService, useValue: { suggest } },
        {
          provide: AccessService,
          useValue: {
            scopeFor: async () => "none" as const,
            getModuleState: async () => true as const,
            buildModuleAvailabilityResolver: (getModuleMap: (orgId: string) => Promise<Record<string, boolean>>) =>
              moduleAvailabilityResolver(
                { isCoreModule: () => true, getModuleMap, getPlanLockedModules: async () => [] },
                { getUserDeniedModules: async () => new Set<string>() },
              ),
          },
        },
        Reflector,
        PermissionGuard,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(HeaderAuthGuard)
      .overrideGuard(ModuleGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /hr/fnf/suggestion is denied without hr:exit:manage (403)", async () => {
    const res = await request(app.getHttpServer()).get("/hr/fnf/suggestion?userId=u2&lastWorkingDay=2026-03-31");
    expect(res.status).toBe(403);
    expect(suggest).not.toHaveBeenCalled();
  });
});
