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
    const service = new ExitCompletionGuardService(
      assetsRecovery as never,
      identity as never,
      hrAudit as never,
    );
    return { service, assetsRecovery, identity, hrAudit };
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
