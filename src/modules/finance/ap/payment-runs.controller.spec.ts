import { Test, type TestingModule } from "@nestjs/testing";
import { INestApplication, CanActivate, ExecutionContext, UnauthorizedException } from "@nestjs/common";
import type { CallHandler, NestInterceptor } from "@nestjs/common";
import request from "supertest";
import { PaymentRunsController } from "./payment-runs.controller";
import { PaymentRunsService } from "./payment-runs.service";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { IdempotencyInterceptor } from "../../../common/idempotency/idempotency.interceptor";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

class PassthroughIdempotencyInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler) {
    return next.handle();
  }
}

const ORG_ID = "org-pay";
const USER_CTX: CurrentUserContext = {
  userId: "u2",
  orgId: ORG_ID,
  role: "ADMIN",
  permissions: [],
  isOrgOwner: false,
  sessionId: "sess2",
  tokenScopes: null,
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

const MOCK_RUN = { id: 1, orgId: ORG_ID, status: "DRAFT", totalAmount: "5000.00" };

const mockPaymentRunsService = {
  listRuns: jest.fn().mockResolvedValue({ data: [], total: 0 }),
  getRun: jest.fn().mockResolvedValue(MOCK_RUN),
  createRun: jest.fn().mockResolvedValue(MOCK_RUN),
  approveRun: jest.fn().mockResolvedValue({ ...MOCK_RUN, status: "APPROVED" }),
  executeRun: jest.fn().mockResolvedValue({ ...MOCK_RUN, status: "EXECUTED" }),
  cancelRun: jest.fn().mockResolvedValue({ ...MOCK_RUN, status: "CANCELLED" }),
  updateRunItem: jest.fn().mockResolvedValue({}),
};

async function buildApp(options: { allowPermission: boolean }): Promise<INestApplication> {
  const moduleRef: TestingModule = await Test.createTestingModule({
    controllers: [PaymentRunsController],
    providers: [{ provide: PaymentRunsService, useValue: mockPaymentRunsService }],
  })
    .overrideGuard(JwtAuthGuard)
    .useClass(HeaderCheckAuthGuard)
    .overrideGuard(PermissionGuard)
    .useClass(options.allowPermission ? AlwaysAllowPermissionGuard : AlwaysDenyPermissionGuard)
    .overrideInterceptor(IdempotencyInterceptor)
    .useClass(PassthroughIdempotencyInterceptor)
    .compile();

  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe("PaymentRunsController — auth guard", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildApp({ allowPermission: true });
  });

  afterAll(() => app.close());

  it("GET /accounting/payment-runs returns 401 without token", async () => {
    const res = await request(app.getHttpServer()).get("/accounting/payment-runs");
    expect(res.status).toBe(401);
  });

  it("POST /accounting/payment-runs returns 401 without token", async () => {
    const res = await request(app.getHttpServer()).post("/accounting/payment-runs");
    expect(res.status).toBe(401);
  });

  it("GET /accounting/payment-runs/1 returns 401 without token", async () => {
    const res = await request(app.getHttpServer()).get("/accounting/payment-runs/1");
    expect(res.status).toBe(401);
  });

  it("POST /accounting/payment-runs/1/approve returns 401 without token", async () => {
    const res = await request(app.getHttpServer()).post("/accounting/payment-runs/1/approve");
    expect(res.status).toBe(401);
  });
});

describe("PaymentRunsController — permission guard deny", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildApp({ allowPermission: false });
  });

  afterAll(() => app.close());

  it("GET /accounting/payment-runs returns 403 without accounting:payment-runs:read", async () => {
    const res = await request(app.getHttpServer())
      .get("/accounting/payment-runs")
      .set("Authorization", "Bearer token");
    expect(res.status).toBe(403);
  });

  it("POST /accounting/payment-runs returns 403 without accounting:payment-runs:manage", async () => {
    const res = await request(app.getHttpServer())
      .post("/accounting/payment-runs")
      .set("Authorization", "Bearer token")
      .send({ runDate: "2024-01-15", paymentMethod: "BANK_TRANSFER", billIds: [1] });
    expect(res.status).toBe(403);
  });

  it("POST /accounting/payment-runs/1/approve returns 403 without accounting:payment-runs:approve", async () => {
    const res = await request(app.getHttpServer())
      .post("/accounting/payment-runs/1/approve")
      .set("Authorization", "Bearer token");
    expect(res.status).toBe(403);
  });
});

describe("PaymentRunsController — permission grant + org isolation", () => {
  let app: INestApplication;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  beforeAll(async () => {
    app = await buildApp({ allowPermission: true });
  });

  afterAll(() => app.close());

  it("GET /accounting/payment-runs returns 200 with permission", async () => {
    const res = await request(app.getHttpServer())
      .get("/accounting/payment-runs")
      .set("Authorization", "Bearer token");
    expect(res.status).toBe(200);
  });

  it("GET /accounting/payment-runs calls service with caller orgId", async () => {
    await request(app.getHttpServer())
      .get("/accounting/payment-runs")
      .set("Authorization", "Bearer token");
    expect(mockPaymentRunsService.listRuns).toHaveBeenCalledWith(ORG_ID, expect.any(Object));
  });

  it("POST /accounting/payment-runs/1/approve calls service with caller context (orgId embedded)", async () => {
    const res = await request(app.getHttpServer())
      .post("/accounting/payment-runs/1/approve")
      .set("Authorization", "Bearer token");
    expect(res.status).toBe(200);
    expect(mockPaymentRunsService.approveRun).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_ID }),
      1,
    );
  });

  it("POST /accounting/payment-runs/1/cancel calls service with caller orgId", async () => {
    await request(app.getHttpServer())
      .post("/accounting/payment-runs/1/cancel")
      .set("Authorization", "Bearer token");
    expect(mockPaymentRunsService.cancelRun).toHaveBeenCalledWith(ORG_ID, USER_CTX.userId, 1);
  });

  it("GET /accounting/payment-runs/1 calls service with caller orgId", async () => {
    await request(app.getHttpServer())
      .get("/accounting/payment-runs/1")
      .set("Authorization", "Bearer token");
    expect(mockPaymentRunsService.getRun).toHaveBeenCalledWith(ORG_ID, 1);
  });
});
