import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { TicketVersionConflictException } from "./ticket-version-conflict.exception";
import { MilestonesService } from "../execution/workspace.service";
import { ProjectsReleasesService } from "./projects-releases.service";
import { ProjectsRoadmapService } from "./projects-roadmap.service";
import { AccessService } from "../../access/access.service";
import { ProjectsChangelogService } from "./projects-changelog.service";
import { ProjectsFeedbackService } from "./projects-feedback.service";
import { systemActor } from "../../../common/auth/system-actor";

const actor = systemActor("integrations.git.webhook", "org-1");

const accessWithBuildManage = {
  resolveUserPermissions: jest.fn().mockResolvedValue(new Set(["build:manage"])),
  holds: jest.fn().mockResolvedValue(true),
};

function makeFindFirst(row: Record<string, unknown> | undefined) {
  return jest.fn().mockResolvedValue(row);
}

function makeSelectChain(rows: Record<string, unknown>[]) {
  return jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue(rows),
      }),
      innerJoin: jest.fn().mockReturnValue({
        innerJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
        }),
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
      }),
    }),
  });
}

function makeUpdateMock(returnRows: Record<string, unknown>[]) {
  return jest.fn().mockReturnValue({
    set: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(returnRows) }),
    }),
  });
}

async function milestonesService(milestoneRow: Record<string, unknown> | undefined, updateReturnRows: Record<string, unknown>[] = []) {
  const update = makeUpdateMock(updateReturnRows);
  const db = {
    update,
    select: makeSelectChain(milestoneRow ? [milestoneRow] : []),
    query: { projectMilestones: { findFirst: makeFindFirst(milestoneRow) } },
  };
  const module = await Test.createTestingModule({
    providers: [
      MilestonesService,
      { provide: DRIZZLE, useValue: db },
      { provide: AccessService, useValue: accessWithBuildManage },
    ],
  }).compile();
  return { service: module.get(MilestonesService), module, update };
}

async function releasesService(releaseRow: Record<string, unknown> | undefined, txRows: Record<string, unknown>[]) {
  const update = makeUpdateMock(txRows);
  const transaction = jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb({ update }),
  );
  const db = {
    transaction,
    select: makeSelectChain(releaseRow ? [releaseRow] : []),
    query: {
      projects: { findFirst: makeFindFirst({ managerMembershipId: null }) },
      projectReleases: { findFirst: makeFindFirst(releaseRow) },
    },
  };
  const module = await Test.createTestingModule({
    providers: [
      ProjectsReleasesService,
      { provide: DRIZZLE, useValue: db },
      { provide: AccessService, useValue: accessWithBuildManage },
    ],
  }).compile();
  return { service: module.get(ProjectsReleasesService), module, transaction };
}

async function roadmapService(itemRow: Record<string, unknown> | undefined, updateReturnRows: Record<string, unknown>[] = []) {
  const update = makeUpdateMock(updateReturnRows);
  const db = {
    update,
    select: makeSelectChain(itemRow ? [itemRow] : []),
    query: { roadmapItems: { findFirst: makeFindFirst(itemRow) } },
  };
  const module = await Test.createTestingModule({
    providers: [
      ProjectsRoadmapService,
      { provide: DRIZZLE, useValue: db },
      { provide: ProjectsChangelogService, useValue: {} },
      { provide: ProjectsFeedbackService, useValue: {} },
    ],
  }).compile();
  return { service: module.get(ProjectsRoadmapService), module, update };
}

it("milestone stale token returns 409 with currentVersion in details (ticket-13)", async () => {
  const { service, module } = await milestonesService({ version: 4 });
  const error = await service.updateMilestone("org-1", 1, 10, { version: 2, name: "M1" }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(TicketVersionConflictException);
  expect((error as TicketVersionConflictException).getResponse()).toMatchObject({ details: { currentVersion: 4 } });
  await module.close();
});

it("milestone matching token does not throw TicketVersionConflictException and runs the update query (BE-141 positive pair)", async () => {
  const updatedMilestone = { id: 10, orgId: "org-1", projectId: 1, name: "M1", version: 5 };
  const { service, module, update } = await milestonesService({ version: 4 }, [updatedMilestone]);
  const error = await service.updateMilestone("org-1", 1, 10, { version: 4, name: "M1" }).catch((e: unknown) => e);
  expect(error).not.toBeInstanceOf(TicketVersionConflictException);
  expect(update).toHaveBeenCalled();
  await module.close();
});

it("release stale token returns 409 with currentVersion in details (ticket-13)", async () => {
  const { service, module } = await releasesService({ rowVersion: 6 }, []);
  const error = await service.updateRelease(actor, 1, 20, { rowVersion: 2, name: "v2" }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(TicketVersionConflictException);
  expect((error as TicketVersionConflictException).getResponse()).toMatchObject({ details: { currentVersion: 6 } });
  await module.close();
});

it("release matching token does not throw TicketVersionConflictException and runs the transaction (BE-141 positive pair)", async () => {
  const releaseRow = { id: 20, orgId: "org-1", projectId: 1, name: "v2", version: "1.0.0", rowVersion: 7, description: null, status: "draft", releaseDate: null, createdBy: null, deletedAt: null, createdAt: new Date(), updatedAt: new Date() };
  const { service, module, transaction } = await releasesService({ rowVersion: 6 }, [releaseRow]);
  const error = await service.updateRelease(actor, 1, 20, { rowVersion: 6, name: "v2" }).catch((e: unknown) => e);
  expect(error).not.toBeInstanceOf(TicketVersionConflictException);
  expect(transaction).toHaveBeenCalled();
  await module.close();
});

it("roadmap stale token returns 409 with currentVersion in details (ticket-13)", async () => {
  const { service, module } = await roadmapService({ version: 9 });
  const error = await service.updateRoadmap("org-1", 50, { version: 3, title: "Feature X" }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(TicketVersionConflictException);
  expect((error as TicketVersionConflictException).getResponse()).toMatchObject({ details: { currentVersion: 9 } });
  await module.close();
});

it("roadmap matching token does not throw TicketVersionConflictException and runs the update query (BE-141 positive pair)", async () => {
  const itemRow = { id: 50, orgId: "org-1", title: "Feature X", description: null, status: "planned", category: null, isPublic: true, projectId: null, epicTicketId: null, targetQuarter: null, sortOrder: 0, votes: 0, reach: null, impact: null, confidence: null, effort: null, version: 10, createdBy: null, createdAt: new Date(), updatedAt: new Date(), deletedAt: null };
  const { service, module, update } = await roadmapService({ version: 9 }, [itemRow]);
  const error = await service.updateRoadmap("org-1", 50, { version: 9, title: "Feature X" }).catch((e: unknown) => e);
  expect(error).not.toBeInstanceOf(TicketVersionConflictException);
  expect(update).toHaveBeenCalled();
  await module.close();
});
