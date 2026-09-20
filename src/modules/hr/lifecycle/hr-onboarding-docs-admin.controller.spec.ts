import { Reflector } from "@nestjs/core";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { ModuleDisabledException } from "../../../common/http/api-exceptions";
import { REQUIRE_MODULE } from "../../../common/rbac/require-module.decorator";
import { HrOnboardingDocsAdminController } from "./hr-onboarding-docs-admin.controller";
import {
  makeGuardCtx,
  MODULE_AVAILABLE,
  MODULE_DISABLED,
} from "../../../../test/helpers/module-guard-context";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const memberUser: Partial<CurrentUserContext> = { orgId: "org-1", userId: "u-1", isOrgOwner: false };

describe("HrOnboardingDocsAdminController — @RequireModule(hr) gate", () => {
  const reflector = new Reflector();
  const guard = new ModuleGuard(reflector);

  it("carries @RequireModule(hr) at class level", () => {
    expect(reflector.get(REQUIRE_MODULE, HrOnboardingDocsAdminController)).toBe("hr");
  });

  describe("HR module DISABLED — all admin handlers refused", () => {
    it("GET /hr/onboarding-docs/summary is blocked", async () => {
      await expect(
        guard.canActivate(
          makeGuardCtx(HrOnboardingDocsAdminController, "summary", memberUser, MODULE_DISABLED),
        ),
      ).rejects.toThrow(ModuleDisabledException);
    });

    it("GET /hr/onboarding-docs (list) is blocked", async () => {
      await expect(
        guard.canActivate(
          makeGuardCtx(HrOnboardingDocsAdminController, "list", memberUser, MODULE_DISABLED),
        ),
      ).rejects.toThrow(ModuleDisabledException);
    });

    it("POST /hr/onboarding-docs (create) is blocked", async () => {
      await expect(
        guard.canActivate(
          makeGuardCtx(HrOnboardingDocsAdminController, "create", memberUser, MODULE_DISABLED),
        ),
      ).rejects.toThrow(ModuleDisabledException);
    });

    it("PATCH /hr/onboarding-docs/:docId (review) is blocked", async () => {
      await expect(
        guard.canActivate(
          makeGuardCtx(HrOnboardingDocsAdminController, "review", memberUser, MODULE_DISABLED),
        ),
      ).rejects.toThrow(ModuleDisabledException);
    });
  });

  describe("getFile — audit written outside the request transaction", () => {
    it("records the admin onboarding document view outside the request transaction, because a GET holds no mutation and writing inside a read-intent transaction blocks read-only transaction mode", async () => {
      const doc = { id: 9, fileUrl: "https://example.com/doc.pdf", fileName: "contract.pdf" };
      const onboardingViews = { getFileReference: jest.fn().mockResolvedValue(doc) };
      const access = { resolveUserPermissions: jest.fn() };
      const storage = {
        getFileKeyFromUrl: jest.fn().mockReturnValue("org-1/onboarding-docs/contract.pdf"),
        isValidFileKey: jest.fn().mockReturnValue(true),
        getFileUrl: jest.fn().mockResolvedValue("https://signed.example.com/contract.pdf"),
      };
      const audit = {
        logCriticalOutsideTransaction: jest.fn().mockResolvedValue(undefined),
        logCritical: jest.fn(),
      };
      const controller = new HrOnboardingDocsAdminController(
        onboardingViews as never,
        access as never,
        storage as never,
        audit as never,
      );
      const user: CurrentUserContext = {
        userId: "user-2",
        orgId: "org-1",
        role: "OWNER",
        isOrgOwner: true,
        sessionId: "sess-2",
        tokenScopes: null,
        principal: humanSessionPrincipal(2, false),
      };

      await controller.getFile(9, user);

      expect(audit.logCriticalOutsideTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ action: "hr.onboarding_document_viewed", userId: "user-2" }),
      );
      expect(audit.logCritical).not.toHaveBeenCalled();
    });
  });

  describe("bite proof — HR module ENABLED, gate passes through", () => {
    it("list handler passes (proving gate is the only blocker)", async () => {
      await expect(
        guard.canActivate(
          makeGuardCtx(HrOnboardingDocsAdminController, "list", memberUser, MODULE_AVAILABLE),
        ),
      ).resolves.toBe(true);
    });
  });
});
