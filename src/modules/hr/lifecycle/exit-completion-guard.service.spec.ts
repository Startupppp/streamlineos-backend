process.env.APP_URL ??= "http://localhost:1000";

import {
  BadRequestException,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ExitCompletionGuardService } from "./exit-completion-guard.service";

const context = {
  orgId: "org-1",
  actorUserId: "admin-1",
  resignationId: 41,
  employeeUserId: "employee-1",
  overrideRequested: false,
};

describe("ExitCompletionGuardService", () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function buildService(options?: {
    assetResult?: boolean;
    assetError?: Error;
    identityResult?: boolean;
    identityError?: Error;
    openItems?: number;
    checklistError?: Error;
  }) {
    const assetsRecovery = {
      hasPendingRecovery: options?.assetError
        ? jest.fn().mockRejectedValue(options.assetError)
        : jest.fn().mockResolvedValue(options?.assetResult ?? false),
    };
    const identity = {
      hasUnverifiedRevokes: options?.identityError
        ? jest.fn().mockRejectedValue(options.identityError)
        : jest.fn().mockResolvedValue(options?.identityResult ?? false),
    };
    const hrAudit = { log: jest.fn().mockResolvedValue(undefined) };
    const checklist = {
      openItemCount: options?.checklistError
        ? jest.fn().mockRejectedValue(options.checklistError)
        : jest.fn().mockResolvedValue(options?.openItems ?? 0),
    };
    const service = new ExitCompletionGuardService(
      assetsRecovery as never,
      identity as never,
      hrAudit as never,
      checklist as never,
    );
    return { service, assetsRecovery, identity, hrAudit, checklist };
  }

  it("fails closed when asset recovery cannot be verified", async () => {
    const { service, identity, hrAudit } = buildService({
      assetError: new Error("database unavailable"),
    });

    await expect(service.assertReady(context)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(identity.hasUnverifiedRevokes).not.toHaveBeenCalled();
    expect(hrAudit.log).not.toHaveBeenCalled();
  });

  it("fails closed when access revocation cannot be verified", async () => {
    const { service, hrAudit } = buildService({
      identityError: new Error("identity provider unavailable"),
    });

    await expect(service.assertReady(context)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(hrAudit.log).not.toHaveBeenCalled();
  });

  it("refuses to complete an exit while a checklist item is still open", async () => {
    const { service, hrAudit } = buildService({ openItems: 2 });

    await expect(service.assertReady(context)).rejects.toBeInstanceOf(BadRequestException);
    expect(hrAudit.log).not.toHaveBeenCalled();
  });

  it("completes once every checklist item is closed or waived and the live gates are clear", async () => {
    const { service, checklist, hrAudit } = buildService({ openItems: 0 });

    await expect(service.assertReady(context)).resolves.toBeUndefined();
    expect(checklist.openItemCount).toHaveBeenCalledWith("org-1", 41);
    expect(hrAudit.log).not.toHaveBeenCalled();
  });

  it("fails closed when the checklist cannot be read", async () => {
    const { service, hrAudit } = buildService({ checklistError: new Error("database unavailable") });

    await expect(service.assertReady(context)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(hrAudit.log).not.toHaveBeenCalled();
  });

  it("audits an explicit override of open checklist items", async () => {
    const { service, hrAudit } = buildService({ openItems: 1 });

    await expect(
      service.assertReady({ ...context, overrideRequested: true, overrideReason: "Employee absconded; items closed offline" }),
    ).resolves.toBeUndefined();

    expect(hrAudit.log).toHaveBeenCalledWith({
      orgId: "org-1",
      actorId: "admin-1",
      entityType: "resignations",
      entityId: "41",
      action: "checklist_gate_overridden",
      after: { reason: "Employee absconded; items closed offline", gateStatus: "dependency_pending" },
    });
  });

  it("requires a reason for every explicit override", async () => {
    const { service, hrAudit } = buildService({ assetResult: true });

    await expect(
      service.assertReady({ ...context, overrideRequested: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(hrAudit.log).not.toHaveBeenCalled();
  });

  it("audits an explicit override of an unavailable dependency", async () => {
    const { service, hrAudit } = buildService({
      assetError: new Error("database unavailable"),
    });

    await expect(
      service.assertReady({
        ...context,
        overrideRequested: true,
        overrideReason: "Approved after manual asset-register review",
      }),
    ).resolves.toBeUndefined();

    expect(hrAudit.log).toHaveBeenCalledWith({
      orgId: "org-1",
      actorId: "admin-1",
      entityType: "resignations",
      entityId: "41",
      action: "asset_gate_check_failed_overridden",
      after: {
        reason: "Approved after manual asset-register review",
        gateStatus: "verification_unavailable",
      },
    });
  });
});
