import { NotFoundException } from "@nestjs/common";

const mockPortalProjectionBuild = jest.fn();

jest.mock("../../build/client-portal/portal-projection.service", () => ({
  PortalProjectionService: jest.fn().mockImplementation(() => ({
    build: mockPortalProjectionBuild,
  })),
}));

const mockDb = {
  select: jest.fn(),
};

const mockAudit = { logCritical: jest.fn() };

const ALL_CAPS_GRANT = {
  projectClientGrantId: "grant-1",
  organizationId: "org-1",
  portalMembershipId: "mem-1",
  projectId: 42,
  status: "ACTIVE",
  expiresAt: null,
  canViewMilestones: true,
  canViewTasks: true,
  canViewAttachments: true,
  canViewComments: true,
  canSubmitChangeRequests: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const DENY_CAPS_GRANT = {
  ...ALL_CAPS_GRANT,
  canViewMilestones: false,
  canViewTasks: false,
  canViewAttachments: false,
  canViewComments: false,
};

const SAMPLE_PROJECT = {
  id: 42,
  name: "Acme",
  key: "ACM",
  status: "active",
  startDate: null,
  targetEndDate: null,
};

function makeDb(grantRow: typeof ALL_CAPS_GRANT | null) {
  const limitMock = jest.fn().mockResolvedValue(grantRow ? [grantRow] : []);
  const whereMock = jest.fn().mockReturnValue({ limit: limitMock });
  const fromMock = jest.fn().mockReturnValue({ where: whereMock });
  const selectMock = jest.fn().mockReturnValue({ from: fromMock });

  const projectLimitMock = jest.fn().mockResolvedValue([SAMPLE_PROJECT]);
  const projectWhereMock = jest.fn().mockReturnValue({ limit: projectLimitMock });
  const projectFromMock = jest.fn().mockReturnValue({ where: projectWhereMock });

  let callCount = 0;
  const db = {
    select: jest.fn(() => {
      callCount++;
      return callCount === 1
        ? { from: fromMock }
        : { from: projectFromMock };
    }),
  };

  return db;
}

describe("PortalClientService.getProjectOverview — delegates projection to PortalProjectionService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("calls portalProjection.build with the grant capabilities so the same seam drives both routes", async () => {
    const { PortalClientService } = await import("./portal-client.service");
    const { PortalProjectionService } = await import(
      "../../build/client-portal/portal-projection.service"
    );

    mockPortalProjectionBuild.mockResolvedValue({
      milestones: [],
      tasks: [],
      attachments: [],
      comments: [],
    });

    const db = makeDb(ALL_CAPS_GRANT);
    const svc = new PortalClientService(
      db as never,
      mockAudit as never,
      new PortalProjectionService(db as never),
    );

    await svc.getProjectOverview("org-1", "mem-1", 42);

    expect(mockPortalProjectionBuild).toHaveBeenCalledWith("org-1", 42, ALL_CAPS_GRANT);
  });

  it("surfaces the projection result alongside the grant capabilities field, preserving the response shape", async () => {
    const { PortalClientService } = await import("./portal-client.service");
    const { PortalProjectionService } = await import(
      "../../build/client-portal/portal-projection.service"
    );

    const projectionResult = {
      milestones: [{ id: 1, name: "M1", dueDate: null, status: "open" }],
      tasks: [],
      attachments: [],
      comments: [],
    };
    mockPortalProjectionBuild.mockResolvedValue(projectionResult);

    const db = makeDb(ALL_CAPS_GRANT);
    const svc = new PortalClientService(
      db as never,
      mockAudit as never,
      new PortalProjectionService(db as never),
    );

    const result = await svc.getProjectOverview("org-1", "mem-1", 42);

    expect(result.milestones).toEqual(projectionResult.milestones);
    expect(result.capabilities).toMatchObject({
      canViewMilestones: true,
      canViewTasks: true,
      canViewAttachments: true,
      canViewComments: true,
      canSubmitChangeRequests: false,
    });
  });

  it("throws NotFoundException when no active grant exists for the membership, so an external client cannot see an ungated project", async () => {
    const { PortalClientService } = await import("./portal-client.service");
    const { PortalProjectionService } = await import(
      "../../build/client-portal/portal-projection.service"
    );

    const db = makeDb(null);
    const svc = new PortalClientService(
      db as never,
      mockAudit as never,
      new PortalProjectionService(db as never),
    );

    await expect(svc.getProjectOverview("org-1", "mem-1", 42)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("NEGATIVE — portalProjection.build is not called when the grant lookup fails, so the DB is not queried unnecessarily", async () => {
    const { PortalClientService } = await import("./portal-client.service");
    const { PortalProjectionService } = await import(
      "../../build/client-portal/portal-projection.service"
    );

    const db = makeDb(null);
    const svc = new PortalClientService(
      db as never,
      mockAudit as never,
      new PortalProjectionService(db as never),
    );

    await expect(svc.getProjectOverview("org-1", "mem-1", 42)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(mockPortalProjectionBuild).not.toHaveBeenCalled();
  });
});
