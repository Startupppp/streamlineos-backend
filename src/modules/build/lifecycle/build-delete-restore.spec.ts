import { ConflictException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { ProjectsRoadmapService } from "../core/roadmap/projects-roadmap.service";
import { ProjectsFeedbackService } from "../core/feedback/projects-feedback.service";
import { ProjectsReleasesService } from "../core/releases/projects-releases.service";
import { TestManagementService } from "../qa/test-management.service";
import { TestRunsService } from "../qa/test-runs.service";
import { MilestonesService } from "../execution/workspace.service";
import { WhiteboardsService } from "../execution/whiteboards.service";
import { BugsService } from "../qa/bugs.service";

const ORG = "org-1";
const USER = "user-7";
const PROJECT = 3;

function makeU(): CurrentUserContext {
  return {
    userId: USER,
    orgId: ORG,
    role: "OWNER",
    isOrgOwner: true,
    sessionId: "session-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(7, true),
  };
}

function auditDouble(): { audit: AuditService; log: jest.Mock } {
  const log = jest.fn();
  const double: Pick<AuditService, "log"> = { log };
  return { audit: double as AuditService, log };
}

function accessDouble(): AccessService {
  const double: Pick<AccessService, "resolveUserPermissions" | "holds"> = {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>(["build:manage"])),
    holds: jest.fn().mockResolvedValue(true),
  };
  return double as AccessService;
}

interface Written {
  set: jest.Mock;
  update: jest.Mock;
}

function updateDouble(returned: unknown[]): Written {
  const returning = jest.fn().mockResolvedValue(returned);
  const where = jest.fn().mockReturnValue({ returning, then: undefined });
  const whenAwaited = Object.assign(where, {});
  const set = jest.fn().mockReturnValue({ where: whenAwaited });
  const update = jest.fn().mockReturnValue({ set });
  return { set, update };
}

function makeDb(
  tableDoubles: Record<string, unknown>,
  written: Written,
  extra: Partial<Record<string, unknown>> = {},
): Db {
  return {
    query: {
      projects: { findFirst: jest.fn().mockResolvedValue({ id: PROJECT, managerMembershipId: null }) },
      ...Object.fromEntries(
        Object.entries(tableDoubles).map(([k, v]) => [k, { findFirst: jest.fn().mockResolvedValue(v) }]),
      ),
    },
    update: written.update,
    ...extra,
  } as unknown as Db;
}

const DELETED = { deletedAt: new Date("2026-01-01T00:00:00Z") };
const LIVE = { deletedAt: null };

describe("build lifecycle — every soft delete in roadmap/releases/feedback/qa/execution writes an audit row", () => {
  it("deleteRoadmap audits build.roadmap_item.deleted", async () => {
    const written = updateDouble([{ id: 9 }]);
    const { audit, log } = auditDouble();
    const svc = new ProjectsRoadmapService(makeDb({}, written), audit);
    await expect(svc.deleteRoadmap(ORG, USER, 9)).resolves.toEqual({ success: true });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "build.roadmap_item.deleted", userId: USER, orgId: ORG, resourceId: "9" }),
    );
  });

  it("deleteFeedback audits build.feedback_post.deleted", async () => {
    const written = updateDouble([{ id: 4 }]);
    const { audit, log } = auditDouble();
    const svc = new ProjectsFeedbackService(makeDb({}, written), audit);
    await expect(svc.deleteFeedback(ORG, USER, 4)).resolves.toEqual({ success: true });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "build.feedback_post.deleted", resourceId: "4" }),
    );
  });

  it("deleteRelease audits build.release.deleted", async () => {
    const written = updateDouble([{ id: 5 }]);
    const { audit, log } = auditDouble();
    const svc = new ProjectsReleasesService(makeDb({}, written), accessDouble(), audit);
    await expect(svc.deleteRelease(makeU(), PROJECT, 5)).resolves.toEqual({ success: true });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "build.release.deleted", resourceId: "5" }),
    );
  });

  it("deleteSuite audits build.test_suite.deleted", async () => {
    const written = updateDouble([]);
    const { audit, log } = auditDouble();
    const svc = new TestManagementService(makeDb({ testSuites: { id: 11 } }, written), accessDouble(), audit);
    await expect(svc.deleteSuite(makeU(), PROJECT, 11)).resolves.toEqual({ success: true });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "build.test_suite.deleted", resourceId: "11" }),
    );
  });

  it("deleteCase audits build.test_case.deleted", async () => {
    const written = updateDouble([]);
    const { audit, log } = auditDouble();
    const svc = new TestManagementService(makeDb({ testCases: { id: 42 } }, written), accessDouble(), audit);
    await expect(svc.deleteCase(makeU(), PROJECT, 42)).resolves.toEqual({ success: true });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "build.test_case.deleted", resourceId: "42" }),
    );
  });

  it("deleteRun audits build.test_run.deleted", async () => {
    const written = updateDouble([]);
    const { audit, log } = auditDouble();
    const svc = new TestRunsService(makeDb({ testRuns: { id: 5 } }, written), accessDouble(), audit);
    await expect(svc.deleteRun(makeU(), PROJECT, 5)).resolves.toEqual({ success: true });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "build.test_run.deleted", resourceId: "5" }),
    );
  });

  it("deleteBug audits bug.deleted, the parallel soft-delete path onto tickets", async () => {
    const written = updateDouble([]);
    const { audit, log } = auditDouble();
    const svc = new BugsService(makeDb({ tickets: { id: 77 } }, written), accessDouble(), audit);
    await expect(svc.deleteBug(makeU(), PROJECT, 77)).resolves.toEqual({ success: true });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "bug.deleted", resourceId: "77" }),
    );
  });

  it("deleteMilestone audits build.milestone.deleted", async () => {
    const written = updateDouble([{ id: 8 }]);
    const { audit, log } = auditDouble();
    const svc = new MilestonesService(makeDb({}, written), accessDouble(), audit);
    await expect(svc.deleteMilestone(makeU(), PROJECT, 8)).resolves.toEqual({ success: true });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "build.milestone.deleted", resourceId: "8" }),
    );
  });

  it("deleteWhiteboard audits build.whiteboard.deleted", async () => {
    const written = updateDouble([]);
    const { audit, log } = auditDouble();
    const boardSelect = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          leftJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest
                .fn()
                .mockResolvedValue([
                  { board: { id: 6, createdBy: USER, visibility: "project" }, shareRole: null },
                ]),
            }),
          }),
        }),
      }),
    };
    const svc = new WhiteboardsService(makeDb({}, written, boardSelect), accessDouble(), audit);
    await expect(svc.deleteWhiteboard(makeU(), PROJECT, 6)).resolves.toEqual({ success: true });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "build.whiteboard.deleted", resourceId: "6" }),
    );
  });
});

describe("build lifecycle — restore clears deleted_at, refuses a live row, and audits", () => {
  it("restoreRoadmap clears deletedAt and audits build.roadmap_item.restored", async () => {
    const written = updateDouble([{ id: 9 }]);
    const { audit, log } = auditDouble();
    const svc = new ProjectsRoadmapService(makeDb({ roadmapItems: DELETED }, written), audit);
    await expect(svc.restoreRoadmap(ORG, USER, 9)).resolves.toEqual({ success: true });
    expect(written.set).toHaveBeenCalledWith({ deletedAt: null });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "build.roadmap_item.restored", resourceId: "9" }),
    );
  });

  it("restoreRoadmap refuses a live roadmap item with 409 and writes nothing", async () => {
    const written = updateDouble([{ id: 9 }]);
    const { audit, log } = auditDouble();
    const svc = new ProjectsRoadmapService(makeDb({ roadmapItems: LIVE }, written), audit);
    await expect(svc.restoreRoadmap(ORG, USER, 9)).rejects.toThrow(ConflictException);
    expect(written.update).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("restoreFeedback clears deletedAt and audits build.feedback_post.restored", async () => {
    const written = updateDouble([{ id: 4 }]);
    const { audit, log } = auditDouble();
    const svc = new ProjectsFeedbackService(makeDb({ feedbackPosts: DELETED }, written), audit);
    await expect(svc.restoreFeedback(ORG, USER, 4)).resolves.toEqual({ success: true });
    expect(written.set).toHaveBeenCalledWith({ deletedAt: null });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "build.feedback_post.restored" }),
    );
  });

  it("restoreRelease clears deletedAt and audits build.release.restored", async () => {
    const written = updateDouble([{ id: 5 }]);
    const { audit, log } = auditDouble();
    const svc = new ProjectsReleasesService(
      makeDb({ projectReleases: DELETED }, written),
      accessDouble(),
      audit,
    );
    await expect(svc.restoreRelease(makeU(), PROJECT, 5)).resolves.toEqual({ success: true });
    expect(written.set).toHaveBeenCalledWith({ deletedAt: null });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ action: "build.release.restored" }));
  });

  it("restoreSuite clears deletedAt and audits build.test_suite.restored", async () => {
    const written = updateDouble([{ id: 11 }]);
    const { audit, log } = auditDouble();
    const svc = new TestManagementService(
      makeDb({ testSuites: DELETED }, written),
      accessDouble(),
      audit,
    );
    await expect(svc.restoreSuite(makeU(), PROJECT, 11)).resolves.toEqual({ success: true });
    expect(written.set).toHaveBeenCalledWith({ deletedAt: null });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "build.test_suite.restored" }),
    );
  });

  it("restoreCase clears deletedAt and audits build.test_case.restored", async () => {
    const written = updateDouble([{ id: 42 }]);
    const { audit, log } = auditDouble();
    const svc = new TestManagementService(
      makeDb({ testCases: DELETED }, written),
      accessDouble(),
      audit,
    );
    await expect(svc.restoreCase(makeU(), PROJECT, 42)).resolves.toEqual({ success: true });
    expect(written.set).toHaveBeenCalledWith({ deletedAt: null });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ action: "build.test_case.restored" }));
  });

  it("restoreRun clears deletedAt and audits build.test_run.restored", async () => {
    const written = updateDouble([{ id: 5 }]);
    const { audit, log } = auditDouble();
    const svc = new TestRunsService(makeDb({ testRuns: DELETED }, written), accessDouble(), audit);
    await expect(svc.restoreRun(makeU(), PROJECT, 5)).resolves.toEqual({ success: true });
    expect(written.set).toHaveBeenCalledWith({ deletedAt: null });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ action: "build.test_run.restored" }));
  });

  it("restoreMilestone clears deletedAt and audits build.milestone.restored", async () => {
    const written = updateDouble([{ id: 8 }]);
    const { audit, log } = auditDouble();
    const svc = new MilestonesService(
      makeDb({ projectMilestones: DELETED }, written),
      accessDouble(),
      audit,
    );
    await expect(svc.restoreMilestone(makeU(), PROJECT, 8)).resolves.toEqual({ success: true });
    expect(written.set).toHaveBeenCalledWith({ deletedAt: null });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ action: "build.milestone.restored" }));
  });

  it("restoreWhiteboard clears deletedAt and audits build.whiteboard.restored", async () => {
    const written = updateDouble([{ id: 6 }]);
    const { audit, log } = auditDouble();
    const svc = new WhiteboardsService(
      makeDb({ projectWhiteboards: { ...DELETED, createdBy: USER, visibility: "project" } }, written),
      accessDouble(),
      audit,
    );
    await expect(svc.restoreWhiteboard(makeU(), PROJECT, 6)).resolves.toEqual({ success: true });
    expect(written.set).toHaveBeenCalledWith({ deletedAt: null });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "build.whiteboard.restored" }),
    );
  });

  it("restoreMilestone refuses when the parent project is soft-deleted, so no orphan is resurrected", async () => {
    const written = updateDouble([{ id: 8 }]);
    const { audit, log } = auditDouble();
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(undefined) },
        projectMilestones: { findFirst: jest.fn().mockResolvedValue(DELETED) },
      },
      update: written.update,
    } as unknown as Db;
    const svc = new MilestonesService(db, accessDouble(), audit);
    await expect(svc.restoreMilestone(makeU(), PROJECT, 8)).rejects.toThrow("Project not found");
    expect(written.update).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
