import { Reflector } from "@nestjs/core";
import type { ExecutionContext } from "@nestjs/common";
import { ModuleDisabledException } from "../../../common/http/api-exceptions";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { REQUIRE_MODULE } from "../../../common/rbac/require-module.decorator";
import { EmployeeRecruitmentController } from "./employee-recruitment.controller";
import {
  makeGuardCtx,
  makeGuardRequest,
  MODULE_DISABLED,
} from "../../../../test/helpers/module-guard-context";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const memberUser: Partial<CurrentUserContext> = { orgId: "org-1", userId: "u-1", isOrgOwner: false };

describe("EmployeeRecruitmentController — self-service, no module gate", () => {
  const reflector = new Reflector();

  it("has no class-level @RequireModule — employees viewing their own assigned interviews is platform-core per CLAUDE.md §8", () => {
    expect(reflector.get(REQUIRE_MODULE, EmployeeRecruitmentController)).toBeUndefined();
  });

  describe("ModuleGuard passes through regardless of HR module status", () => {
    const guard = new ModuleGuard(new Reflector());

    it("GET /me/recruitment (list) is reachable without HR module", async () => {
      await expect(
        guard.canActivate(
          makeGuardCtx(EmployeeRecruitmentController, "list", memberUser, MODULE_DISABLED),
        ),
      ).resolves.toBe(true);
    });

    it("POST /me/recruitment/:interviewId/scorecard (submitScorecard) is reachable without HR module", async () => {
      await expect(
        guard.canActivate(
          makeGuardCtx(EmployeeRecruitmentController, "submitScorecard", memberUser, MODULE_DISABLED),
        ),
      ).resolves.toBe(true);
    });
  });

  describe("bite proof — adding @RequireModule would cause the above tests to fail", () => {
    it("ModuleGuard blocks when @RequireModule(hr) is set on a gated class", async () => {
      const gatedGuard = new ModuleGuard(new Reflector());
      const fakeClass = class FakeGated {};
      Reflect.defineMetadata(REQUIRE_MODULE, "hr", fakeClass);
      const req = makeGuardRequest(memberUser, MODULE_DISABLED);
      const ctx: ExecutionContext = {
        getHandler: () => () => undefined,
        getClass: () => fakeClass,
        switchToHttp: () => ({ getRequest: () => req }),
      } as unknown as ExecutionContext;
      await expect(gatedGuard.canActivate(ctx)).rejects.toThrow(ModuleDisabledException);
    });
  });
});
