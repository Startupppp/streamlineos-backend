import { Reflector } from "@nestjs/core";
import type { ExecutionContext } from "@nestjs/common";
import { ModuleDisabledException } from "../../../common/http/api-exceptions";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { REQUIRE_MODULE } from "../../../common/rbac/require-module.decorator";
import { HrDocumentTypesController } from "./hr-document-types.controller";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

function makeGuardCtx(
  ctrl: Function,
  methodName: string,
  user: Partial<CurrentUserContext>,
): ExecutionContext {
  const handler = (ctrl.prototype as Record<string, unknown>)[methodName] as Function;
  return {
    getHandler: () => handler,
    getClass: () => ctrl,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

const memberUser: Partial<CurrentUserContext> = { orgId: "org-1", userId: "u-1", isOrgOwner: false };

describe("HrDocumentTypesController — dual-access reads, no module gate", () => {
  const reflector = new Reflector();

  it("has no class-level @RequireModule — read handlers serve both HR admins and self-service employees", () => {
    expect(reflector.get(REQUIRE_MODULE, HrDocumentTypesController)).toBeUndefined();
  });

  describe("ModuleGuard passes through regardless of HR module status", () => {
    const disabledGuard = new ModuleGuard(
      new Reflector(),
      {
        moduleAvailability: jest.fn().mockResolvedValue({ available: false, reason: "org-disabled" }),
      } as unknown as AccessService,
    );

    it("GET /hr/document-types (list) is reachable without HR module (self:onboarding-docs path)", async () => {
      await expect(
        disabledGuard.canActivate(makeGuardCtx(HrDocumentTypesController, "list", memberUser)),
      ).resolves.toBe(true);
    });

    it("GET /hr/document-types/:documentTypeId (getOne) is reachable without HR module", async () => {
      await expect(
        disabledGuard.canActivate(makeGuardCtx(HrDocumentTypesController, "getOne", memberUser)),
      ).resolves.toBe(true);
    });
  });

  describe("bite proof — adding @RequireModule would cause the above tests to fail", () => {
    it("ModuleGuard blocks when @RequireModule(hr) is set on a gated class", async () => {
      const reflectorWithGate = new Reflector();
      const gatedGuard = new ModuleGuard(
        reflectorWithGate,
        {
          moduleAvailability: jest.fn().mockResolvedValue({ available: false, reason: "org-disabled" }),
        } as unknown as AccessService,
      );
      const fakeClass = class FakeGatedController {};
      Reflect.defineMetadata(REQUIRE_MODULE, "hr", fakeClass);
      const handler = () => undefined;
      const ctx: ExecutionContext = {
        getHandler: () => handler,
        getClass: () => fakeClass,
        switchToHttp: () => ({ getRequest: () => ({ user: memberUser }) }),
      } as unknown as ExecutionContext;
      await expect(gatedGuard.canActivate(ctx)).rejects.toThrow(ModuleDisabledException);
    });
  });
});
