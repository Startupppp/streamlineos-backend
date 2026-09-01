import { NotFoundException } from "@nestjs/common";
import { ClientPortalService } from "./client-portal.service";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";

const mockAudit = { log: jest.fn() } as unknown as AuditService;

beforeEach(() => {
  jest.resetAllMocks();
});

describe("ClientPortalService — client isolation (assertClientProject)", () => {
  it("listPortalChangeRequests throws NotFoundException when caller is not the project client", async () => {
    const mockDb = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
    } as unknown as Db;

    const svc = new ClientPortalService(mockDb, mockAudit);
    await expect(svc.listPortalChangeRequests("org-1", null, "not-the-client", 1)).rejects.toThrow(
      NotFoundException,
    );
    expect((mockDb.query.projects.findFirst as jest.Mock)).toHaveBeenCalledTimes(1);
  });

  it("createPortalChangeRequest throws NotFoundException when caller is not the project client", async () => {
    const mockDb = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
    } as unknown as Db;

    const svc = new ClientPortalService(mockDb, mockAudit);
    await expect(
      svc.createPortalChangeRequest("org-1", null, "not-the-client", 1, { title: "Add OAuth" }),
    ).rejects.toThrow(NotFoundException);
  });

  it("listPortalChangeRequests proceeds when assertClientProject finds the project", async () => {
    const crRow = { id: 1, crNumber: 1, title: "Add OAuth", status: "submitted", createdAt: new Date() };
    const crChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([crRow]),
      orderBy: jest.fn().mockResolvedValue([crRow]),
    };
    const mockDb = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
      },
      select: jest.fn().mockReturnValue(crChain),
    } as unknown as Db;

    const svc = new ClientPortalService(mockDb, mockAudit);
    const result = await svc.listPortalChangeRequests("org-1", null, "client-user", 1);
    expect(Array.isArray(result)).toBe(true);
  });
});

describe("ClientPortalService.getProjectOverview — client isolation + field safety", () => {
  it("throws NotFoundException when no project found for (orgId, projectId, clientId=caller)", async () => {
    const selectChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    };
    const mockDb = {
      select: jest.fn().mockReturnValue(selectChain),
    } as unknown as Db;

    const svc = new ClientPortalService(mockDb, mockAudit);
    await expect(svc.getProjectOverview("org-1", null, "wrong-client", 1)).rejects.toThrow(NotFoundException);
  });

  it("SELECT projection does not include budget or internal fields", async () => {
    const selectChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    };
    const selectMock = jest.fn().mockReturnValue(selectChain);
    const mockDb = { select: selectMock } as unknown as Db;

    const svc = new ClientPortalService(mockDb, mockAudit);
    await expect(svc.getProjectOverview("org-1", null, "client-1", 1)).rejects.toThrow(NotFoundException);

    expect(selectMock).toHaveBeenCalled();
    const projection = (selectMock.mock.calls[0] as [Record<string, unknown>])[0];
    expect(projection).not.toHaveProperty("budget");
    expect(projection).not.toHaveProperty("budgetCents");
    expect(projection).not.toHaveProperty("estimateCents");
    expect(projection).not.toHaveProperty("managerId");
    expect(projection).toHaveProperty("id");
    expect(projection).toHaveProperty("name");
    expect(projection).toHaveProperty("key");
    expect(projection).toHaveProperty("status");
    expect(projection).toHaveProperty("startDate");
    expect(projection).toHaveProperty("targetEndDate");
  });

  it("returns project with milestones, tasks, attachments, comments when caller is the client", async () => {
    const projectRow = { id: 1, name: "Portal Project", key: "PP", status: "active", startDate: null, targetEndDate: null };

    const firstSelectChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([projectRow]),
    };

    const emptyPromise = Promise.resolve([]);
    const parallelChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnValue(emptyPromise),
    };

    const selectMock = jest.fn()
      .mockReturnValueOnce(firstSelectChain)
      .mockReturnValue(parallelChain);

    const mockDb = { select: selectMock } as unknown as Db;

    const svc = new ClientPortalService(mockDb, mockAudit);
    const result = await svc.getProjectOverview("org-1", null, "client-user", 1);

    expect(result).toMatchObject({
      project: { id: 1, name: "Portal Project", key: "PP" },
      milestones: [],
      tasks: [],
      attachments: [],
      comments: [],
    });
    expect(result.project).not.toHaveProperty("budgetCents");
    expect(result.project).not.toHaveProperty("estimateCents");
  });
});

describe("ClientPortalService.listPortalProjects — SELECT field safety", () => {
  it("SELECT projection does not include budget or internal fields", async () => {
    const projectRow = { id: 1, name: "P", key: "P1", status: "active", startDate: null, targetEndDate: null };
    const chain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([projectRow]),
    };
    const selectMock = jest.fn().mockReturnValue(chain);
    const mockDb = { select: selectMock } as unknown as Db;

    const svc = new ClientPortalService(mockDb, mockAudit);
    await svc.listPortalProjects("org-1", null, "client-1");

    expect(selectMock).toHaveBeenCalledTimes(1);
    const projection = (selectMock.mock.calls[0] as [Record<string, unknown>])[0];
    expect(projection).not.toHaveProperty("budget");
    expect(projection).not.toHaveProperty("budgetCents");
    expect(projection).not.toHaveProperty("estimateCents");
    expect(projection).not.toHaveProperty("managerId");
    expect(projection).toHaveProperty("id");
    expect(projection).toHaveProperty("name");
    expect(projection).toHaveProperty("key");
    expect(projection).toHaveProperty("status");
    expect(projection).toHaveProperty("targetEndDate");
  });
});
