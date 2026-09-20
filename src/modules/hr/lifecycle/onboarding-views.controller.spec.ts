import { Reflector } from "@nestjs/core";
import type { ExecutionContext } from "@nestjs/common";
import { ModuleDisabledException } from "../../../common/http/api-exceptions";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { REQUIRE_MODULE } from "../../../common/rbac/require-module.decorator";
import { OnboardingViewsController } from "./onboarding-views.controller";
import {
  makeGuardCtx,
  makeGuardRequest,
  MODULE_DISABLED,
} from "../../../../test/helpers/module-guard-context";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const memberUser: Partial<CurrentUserContext> = { orgId: "org-1", userId: "u-1", isOrgOwner: false };

describe("OnboardingViewsController — self-service, no module gate", () => {
  const reflector = new Reflector();

  it("has no class-level @RequireModule — employment documents are platform-core per CLAUDE.md §8", () => {
    expect(reflector.get(REQUIRE_MODULE, OnboardingViewsController)).toBeUndefined();
  });

  describe("ModuleGuard passes through regardless of HR module status", () => {
    const guard = new ModuleGuard(new Reflector());

    it("GET /hr/onboarding-docs/me (listMine) is reachable without HR module", async () => {
      await expect(
        guard.canActivate(
          makeGuardCtx(OnboardingViewsController, "listMine", memberUser, MODULE_DISABLED),
        ),
      ).resolves.toBe(true);
    });

    it("POST /hr/onboarding-docs/me (createMine) is reachable without HR module", async () => {
      await expect(
        guard.canActivate(
          makeGuardCtx(OnboardingViewsController, "createMine", memberUser, MODULE_DISABLED),
        ),
      ).resolves.toBe(true);
    });

    it("GET /hr/onboarding-docs/me/:docId/file (getMyFile) is reachable without HR module", async () => {
      await expect(
        guard.canActivate(
          makeGuardCtx(OnboardingViewsController, "getMyFile", memberUser, MODULE_DISABLED),
        ),
      ).resolves.toBe(true);
    });
  });

  describe("getMyFile — audit written outside the request transaction", () => {
    it("records the onboarding document view outside the request transaction, because a GET holds no mutation and writing inside a read-intent transaction blocks read-only transaction mode", async () => {
      const doc = { id: 7, fileUrl: "https://example.com/file.pdf", fileName: "offer.pdf" };
      const onboardingViews = { getFileReference: jest.fn().mockResolvedValue(doc) };
      const storage = {
        getFileKeyFromUrl: jest.fn().mockReturnValue("org-1/onboarding/offer.pdf"),
        isValidFileKey: jest.fn().mockReturnValue(true),
        getFileUrl: jest.fn().mockResolvedValue("https://signed.example.com/offer.pdf"),
      };
      const audit = {
        logCriticalOutsideTransaction: jest.fn().mockResolvedValue(undefined),
        logCritical: jest.fn(),
      };
      const controller = new OnboardingViewsController(
        onboardingViews as never,
        storage as never,
        audit as never,
      );
      const user: CurrentUserContext = {
        userId: "user-1",
        orgId: "org-1",
        role: "EMPLOYEE",
        isOrgOwner: false,
        sessionId: "sess-1",
        tokenScopes: null,
        principal: humanSessionPrincipal(1, false),
      };

      await controller.getMyFile(7, user);

      expect(audit.logCriticalOutsideTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ action: "hr.onboarding_document_viewed", userId: "user-1" }),
      );
      expect(audit.logCritical).not.toHaveBeenCalled();
    });
  });

  describe("bite proof — adding @RequireModule would cause all three tests above to fail", () => {
    it("ModuleGuard throws when @RequireModule is set (proves the above tests are load-bearing)", async () => {
      const gatedGuard = new ModuleGuard(new Reflector());
      const fakeClass = class FakeGatedController {};
      Reflect.defineMetadata(REQUIRE_MODULE, "hr", fakeClass);
      const handler = () => undefined;
      const req = makeGuardRequest(memberUser, MODULE_DISABLED);
      const ctx: ExecutionContext = {
        getHandler: () => handler,
        getClass: () => fakeClass,
        switchToHttp: () => ({ getRequest: () => req }),
      } as unknown as ExecutionContext;
      await expect(gatedGuard.canActivate(ctx)).rejects.toThrow(ModuleDisabledException);
    });
  });
});
