import { ForbiddenException } from "@nestjs/common";
import type { Request } from "express";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { GdprController } from "./gdpr.controller";
import { authorize } from "../access/authorize";
import { createAuthContext } from "../../common/auth/auth-context";

jest.mock("../access/authorize");

const USER = {
  userId: "user-caller",
  orgId: "org-1",
} as CurrentUserContext;

const AUTH_CTX = createAuthContext(USER, {
  moduleAvailability: async () => ({ available: true }),
});

function buildController() {
  const gdpr = { exportSubjectData: jest.fn(), recordExportRequest: jest.fn() };
  const gdprExport = {
    create: jest.fn().mockResolvedValue({ id: "job-1" }),
    get: jest.fn().mockResolvedValue({ id: "job-1", status: "pending" }),
    download: jest.fn().mockResolvedValue({
      job: { id: "job-1", fileName: "export.json" },
      file: { body: { pipe: jest.fn() }, contentType: "application/json" },
    }),
  };
  const gdprRectification = { rectifyOwnProfile: jest.fn().mockResolvedValue({ requestId: 1 }) };
  const gdprErasure = { eraseSubject: jest.fn().mockResolvedValue({ blocked: false, dryRun: false, tablesAnonymised: [], globalIdentityAnonymised: false }) };
  const access = {};
  return {
    controller: new GdprController(
      gdpr as never,
      gdprExport as never,
      gdprRectification as never,
      gdprErasure as never,
      access as never,
    ),
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

describe("GdprController.getExportJobStatus — G1: admin view uses authorize(), not req.rbacScope", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("passes isAdmin=true to get() when the caller holds hr:retention:manage with all scope", async () => {
    (authorize as jest.Mock).mockResolvedValue({ allow: true, scope: "all" });
    const { controller, gdprExport } = buildController();

    await controller.getExportJobStatus("job-1", USER, AUTH_CTX);

    expect(gdprExport.get).toHaveBeenCalledWith(USER.userId, USER.orgId, "job-1", true);
  });

  it("passes isAdmin=false to get() when the caller lacks hr:retention:manage", async () => {
    (authorize as jest.Mock).mockResolvedValue({ allow: false, scope: "none", reason: "FORBIDDEN" });
    const { controller, gdprExport } = buildController();

    await controller.getExportJobStatus("job-1", USER, AUTH_CTX);

    expect(gdprExport.get).toHaveBeenCalledWith(USER.userId, USER.orgId, "job-1", false);
  });

  it("passes isAdmin=false when the caller holds the permission with own scope (not all)", async () => {
    (authorize as jest.Mock).mockResolvedValue({ allow: true, scope: "own" });
    const { controller, gdprExport } = buildController();

    await controller.getExportJobStatus("job-1", USER, AUTH_CTX);

    expect(gdprExport.get).toHaveBeenCalledWith(USER.userId, USER.orgId, "job-1", false);
  });

  it("throws ForbiddenException when orgId is absent, before calling authorize", async () => {
    (authorize as jest.Mock).mockResolvedValue({ allow: true, scope: "all" });
    const { controller } = buildController();
    const noOrg = { ...USER, orgId: undefined } as unknown as CurrentUserContext;

    await expect(controller.getExportJobStatus("job-1", noOrg, AUTH_CTX)).rejects.toBeInstanceOf(ForbiddenException);
    expect(authorize).not.toHaveBeenCalled();
  });
});
