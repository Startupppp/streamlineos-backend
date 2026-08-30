import {
  Controller,
  Get,
  type INestApplication,
  UseGuards,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Public } from "../../common/auth/public.decorator";
import { AccessService } from "./access.service";
import type { DataScope } from "./access.types";
import { moduleAvailabilityResolver } from "../../common/rbac/module-availability";
import { PermissionGuard } from "./permission.guard";
import { RequirePermission } from "./require-permission.decorator";

@Controller("permission-guard-test")
@UseGuards(PermissionGuard)
class PermissionGuardTestController {
  @Get("missing")
  missingPermission() {
    return { ok: true };
  }

  @Public()
  @Get("public")
  publicRoute() {
    return { ok: true };
  }

  @RequirePermission("settings:rbac:manage")
  @Get("protected")
  protectedRoute() {
    return { ok: true };
  }

  @Public()
  @RequirePermission("settings:rbac:manage")
  @Get("public-authentication")
  publicAuthenticationRoute() {
    return { ok: true };
  }
}

const user: CurrentUserContext = {
  userId: "user-1",
  orgId: "org-1",
  role: "ADMIN",
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
};

function attachUser(req: Request, _res: Response, next: NextFunction): void {
  (req as Request & { user: CurrentUserContext }).user = { ...user };
  next();
}

describe("PermissionGuard routes (e2e)", () => {
  let app: INestApplication;
  const resolveUserPermissions = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PermissionGuardTestController],
      providers: [
        PermissionGuard,
        Reflector,
        {
          provide: AccessService,
          /**
           * `resolveUserPermissions` is still the single fake these cases drive;
           * the rest is what `authorize` reaches for on the way to it.
           *
           * The guard used to read the permission map directly. It now resolves
           * module availability first and then asks `scopeFor` for one key — so
           * a mock carrying only the old two names left `authorize` calling
           * `getModuleState` on an object without one, and every case here
           * answered 403 whatever the map said. Derived rather than given its
           * own fake, so a test that sets the map still decides the outcome.
           */
          useValue: {
            resolveUserPermissions,
            isModuleEnabled: jest.fn().mockResolvedValue(true),
            getModuleState: async (): Promise<boolean> => true,
            getUserDeniedModules: async (): Promise<ReadonlySet<string>> => new Set<string>(),
            buildModuleAvailabilityResolver: (
              getModuleMap: (orgId: string) => Promise<Record<string, boolean>>,
            ) =>
              moduleAvailabilityResolver(
                { isCoreModule: () => false, getModuleMap, getPlanLockedModules: async () => [] },
                { getUserDeniedModules: async () => new Set<string>() },
              ),
            scopeFor: async (ctx: unknown, permissionKey: string): Promise<DataScope> =>
              ((await resolveUserPermissions(ctx)) as Map<string, DataScope> | undefined)?.get(
                permissionKey,
              ) ?? "none",
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(attachUser);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    resolveUserPermissions.mockReset();
  });

  it("denies a guarded route without permission metadata", async () => {
    await request(app.getHttpServer())
      .get("/permission-guard-test/missing")
      .expect(403);
  });

  it("allows an explicitly public route through a guarded controller", async () => {
    await request(app.getHttpServer())
      .get("/permission-guard-test/public")
      .expect(200, { ok: true });
    expect(resolveUserPermissions).not.toHaveBeenCalled();
  });

  it("allows a protected route when permission resolution grants access", async () => {
    resolveUserPermissions.mockResolvedValue(
      new Map([["settings:rbac:manage", "all"]]),
    );

    await request(app.getHttpServer())
      .get("/permission-guard-test/protected")
      .expect(200, { ok: true });
  });

  it("denies a protected route when permission resolution rejects access", async () => {
    resolveUserPermissions.mockResolvedValue(new Map());

    await request(app.getHttpServer())
      .get("/permission-guard-test/protected")
      .expect(403);
  });

  it("enforces explicit permission metadata on a public authentication route", async () => {
    resolveUserPermissions.mockResolvedValue(new Map());

    await request(app.getHttpServer())
      .get("/permission-guard-test/public-authentication")
      .expect(403);
  });
});
