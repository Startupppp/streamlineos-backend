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
import { attachTestAuthContext } from "../../../test/helpers/module-guard-context";
import type { AuthContext } from "../../common/auth/auth-context";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../common/auth/principal";
import { Public } from "../../common/auth/public.decorator";
import { AccessService } from "./access.service";
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
  principal: humanSessionPrincipal(1, false),
};

type AuthenticatedRequest = Request & {
  user?: CurrentUserContext;
  authContext?: AuthContext;
};

function attachUser(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction,
): void {
  attachTestAuthContext(req, { ...user });
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
          useValue: {
            resolveUserPermissions,
            isModuleEnabled: jest.fn().mockResolvedValue(true),
            getModuleState: jest.fn().mockResolvedValue(true),
            scopeFor: jest.fn(async (user: CurrentUserContext, key: string) => {
              if (user.isOrgOwner) return "all";
              const resolved = await resolveUserPermissions(user.orgId, user.userId);
              return resolved.get(key) ?? "none";
            }),
            buildModuleAvailabilityResolver: () => ({
              isCoreModule: () => true,
              getModuleMap: async () => ({}),
              getUserDeniedModules: async () => new Set<string>(),
              getPlanLockedModules: async () => [],
            }),
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
