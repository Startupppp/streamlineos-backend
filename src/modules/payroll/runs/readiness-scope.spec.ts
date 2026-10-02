import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { DataScope } from "../../access/access.types";
import { AccessService } from "../../access/access.service";
import { PermissionGuard } from "../../access/permission.guard";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { PayrollReadinessController } from "./readiness.controller";
import { PayrollReadinessService } from "./readiness.service";

const MEMBER: CurrentUserContext = {
  userId: "payroll-member",
  orgId: "org-readiness",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "sess-readiness",
  tokenScopes: null,
  principal: humanSessionPrincipal(41, false),
};

const PASS = { canActivate: () => true };

const LEDGER = { month: "2026-09", stages: [], exceptions: [], exports: [] };

async function readinessFor(scope: DataScope) {
  const getReadiness = jest.fn().mockResolvedValue(LEDGER);
  const moduleRef = await Test.createTestingModule({
    controllers: [PayrollReadinessController],
    providers: [
      { provide: PayrollReadinessService, useValue: { getReadiness } },
      {
        provide: AccessService,
        useValue: { resolveUserPermissions: async () => new Map([["payroll:runs:view", scope]]) },
      },
    ],
  })
    .overrideGuard(JwtAuthGuard)
    .useValue(PASS)
    .overrideGuard(ModuleGuard)
    .useValue(PASS)
    .overrideGuard(PermissionGuard)
    .useValue(PASS)
    .compile();
  return { controller: moduleRef.get(PayrollReadinessController), getReadiness };
}

describe("GET /payroll/readiness — the org's pay-period ledger names every employee's pending period, so it is read only at scope all", () => {
  it("refuses an own-scoped payroll:runs:view holder with 404 and never builds the ledger", async () => {
    const { controller, getReadiness } = await readinessFor("own");

    await expect(controller.get({ month: "2026-09" }, MEMBER)).rejects.toBeInstanceOf(NotFoundException);
    expect(getReadiness).not.toHaveBeenCalled();
  });

  it("refuses a team-scoped holder the same way", async () => {
    const { controller, getReadiness } = await readinessFor("team");

    await expect(controller.get({ month: "2026-09" }, MEMBER)).rejects.toBeInstanceOf(NotFoundException);
    expect(getReadiness).not.toHaveBeenCalled();
  });

  it("returns the ledger for the caller's own organisation to a holder at scope all", async () => {
    const { controller, getReadiness } = await readinessFor("all");

    await expect(controller.get({ month: "2026-09" }, MEMBER)).resolves.toEqual(LEDGER);
    expect(getReadiness).toHaveBeenCalledWith("org-readiness", "2026-09");
  });

  it("returns the ledger to the org owner without consulting the grant map", async () => {
    const { controller, getReadiness } = await readinessFor("none");

    await expect(controller.get({ month: "2026-09" }, { ...MEMBER, isOrgOwner: true })).resolves.toEqual(LEDGER);
    expect(getReadiness).toHaveBeenCalledTimes(1);
  });
});
