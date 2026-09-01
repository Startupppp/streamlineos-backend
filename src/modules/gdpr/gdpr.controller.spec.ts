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
  const gdprRectification = { rectifyOwnProfile: jest.fn().mockResolvedValue({ requestId: 1 }) };
  return {
    controller: new GdprController(gdpr as never, gdprExport as never, gdprRectification as never),
    gdprExport,
    gdprRectification,
  };
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

describe("GdprController self-service rectification", () => {
  it("binds rectification to the authenticated subject and organization", async () => {
    const { controller, gdprRectification } = buildController();

    await controller.rectifyOwnProfile(
      USER,
      { field: "profile.name", value: "Ananya Rao" },
      { ip: "127.0.0.1" } as Request,
    );

    expect(gdprRectification.rectifyOwnProfile).toHaveBeenCalledWith(
      USER.orgId,
      USER.userId,
      { field: "profile.name", value: "Ananya Rao" },
      "127.0.0.1",
    );
  });
});
