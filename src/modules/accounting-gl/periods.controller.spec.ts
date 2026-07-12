import { Test, type TestingModule } from "@nestjs/testing";
import { INestApplication, CanActivate, ExecutionContext, UnauthorizedException } from "@nestjs/common";
import request from "supertest";
import { PeriodsController } from "./periods.controller";
import { PeriodsService } from "./periods.service";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

const ORG_ID = "org-abc";
const USER_CTX: CurrentUserContext = {
  userId: "u1",
  orgId: ORG_ID,
  branchId: null,
  role: "ADMIN",
  permissions: [],
  enabledModules: [],
  plan: null,
  isPlatformAdmin: false,
  isOrgOwner: false,
  sessionId: "sess1",
};

class HeaderCheckAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ headers: { authorization?: string }; user?: CurrentUserContext }>();
    if (!req.headers.authorization?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Unauthorized");
    }
    req.user = USER_CTX;
    return true;
  }
}

class AlwaysDenyPermissionGuard implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}

class AlwaysAllowPermissionGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

const mockPeriodsService = {
  listPeriods: jest.fn().mockResolvedValue([]),
  generatePeriods: jest.fn().mockResolvedValue({ created: 12, total: 12 }),
  closePeriod: jest.fn().mockResolvedValue({ id: 1, status: "CLOSED" }),
  lockPeriod: jest.fn().mockResolvedValue({ id: 1, status: "LOCKED" }),
  reopenPeriod: jest.fn().mockResolvedValue({ id: 1, status: "OPEN" }),
  getCloseChecklist: jest.fn().mockResolvedValue({ canClose: true, checklist: {} }),
};

async function buildApp(options: { allowPermission: boolean }): Promise<INestApplication> {
  const moduleRef: TestingModule = await Test.createTestingModule({
    controllers: [PeriodsController],
    providers: [{ provide: PeriodsService, useValue: mockPeriodsService }],
  })
    .overrideGuard(JwtAuthGuard)
    .useClass(HeaderCheckAuthGuard)
    .overrideGuard(PermissionGuard)
    .useClass(options.allowPermission ? AlwaysAllowPermissionGuard : AlwaysDenyPermissionGuard)
    .compile();

  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe("PeriodsController — auth guard", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildApp({ allowPermission: true });
  });

  afterAll(() => app.close());

  it("GET /accounting/periods returns 401 without token", async () => {
    const res = await request(app.getHttpServer()).get("/accounting/periods");
    expect(res.status).toBe(401);
  });

  it("POST /accounting/periods returns 401 without token", async () => {
    const res = await request(app.getHttpServer()).post("/accounting/periods");
    expect(res.status).toBe(401);
  });

  it("POST /accounting/periods/1/close returns 401 without token", async () => {
    const res = await request(app.getHttpServer()).post("/accounting/periods/1/close");
    expect(res.status).toBe(401);
  });
});

describe("PeriodsController — permission guard deny", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildApp({ allowPermission: false });
  });

  afterAll(() => app.close());

  it("GET /accounting/periods returns 403 without accounting:periods:read", async () => {
    const res = await request(app.getHttpServer())
      .get("/accounting/periods")
      .set("Authorization", "Bearer token");
    expect(res.status).toBe(403);
  });

  it("POST /accounting/periods returns 403 without accounting:periods:manage", async () => {
    const res = await request(app.getHttpServer())
      .post("/accounting/periods")
      .set("Authorization", "Bearer token")
      .send({ year: 2024 });
    expect(res.status).toBe(403);
  });
});

describe("PeriodsController — permission grant + org isolation", () => {
  let app: INestApplication;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  beforeAll(async () => {
    app = await buildApp({ allowPermission: true });
  });

  afterAll(() => app.close());

  it("GET /accounting/periods returns 200 with permission", async () => {
    const res = await request(app.getHttpServer())
      .get("/accounting/periods")
      .set("Authorization", "Bearer token");
    expect(res.status).toBe(200);
  });

  it("GET /accounting/periods calls service with caller orgId", async () => {
    await request(app.getHttpServer())
      .get("/accounting/periods")
      .set("Authorization", "Bearer token");
    expect(mockPeriodsService.listPeriods).toHaveBeenCalledWith(ORG_ID);
  });

  it("POST /accounting/periods/1/close calls service with caller orgId and userId", async () => {
    const res = await request(app.getHttpServer())
      .post("/accounting/periods/1/close")
      .set("Authorization", "Bearer token");
    expect(res.status).toBe(200);
    expect(mockPeriodsService.closePeriod).toHaveBeenCalledWith(ORG_ID, USER_CTX.userId, 1);
  });

  it("POST /accounting/periods/1/lock calls service with caller orgId", async () => {
    await request(app.getHttpServer())
      .post("/accounting/periods/1/lock")
      .set("Authorization", "Bearer token");
    expect(mockPeriodsService.lockPeriod).toHaveBeenCalledWith(ORG_ID, USER_CTX.userId, 1);
  });
});
