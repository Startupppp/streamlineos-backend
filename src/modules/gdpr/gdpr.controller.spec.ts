import { ForbiddenException } from "@nestjs/common";
import type { Request } from "express";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { GdprController } from "./gdpr.controller";

const USER = {
  userId: "user-caller",
  orgId: "org-1",
} as CurrentUserContext;

function buildController() {
  const gdpr = { exportSubjectData: jest.fn(), recordExportRequest: jest.fn() };
  const gdprExport = { create: jest.fn().mockResolvedValue({ id: "job-1" }) };
  return { controller: new GdprController(gdpr as never, gdprExport as never), gdprExport };
}

describe("GdprController async person export authorization", () => {
  it("rejects another subject when the resolved scope is not organization-wide", async () => {
    const { controller, gdprExport } = buildController();

    await expect(
      controller.createPersonExportJob(
        "user-other",
        USER,
        { idempotencyKey: "key-1" },
        { rbacScope: "team" } as Request & { rbacScope: "team" },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(gdprExport.create).not.toHaveBeenCalled();
  });

  it("allows the caller's own export with an own scope", async () => {
    const { controller, gdprExport } = buildController();

    await controller.createPersonExportJob(
      USER.userId,
      USER,
      { idempotencyKey: "key-1" },
      { rbacScope: "own" } as Request & { rbacScope: "own" },
    );

    expect(gdprExport.create).toHaveBeenCalledWith(
      USER.userId,
      USER.orgId,
      USER.userId,
      "key-1",
    );
  });
});
