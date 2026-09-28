process.env.APP_URL ??= "http://localhost:1000";

import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { ProjectsMembersService } from "./members/projects-members.service";
import { ProjectsTicketsCreateService } from "./tickets/projects-tickets-create.service";
import * as actorSeam from "../../../common/organization/organization-actor";
import type { AccessService } from "../../access/access.service";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import * as projectAccessSeam from "./project-crud/project-access";

jest.mock("../../../common/organization/organization-actor", () => ({
  assertOrganizationActor: jest.fn(),
  resolveOrganizationActorsByUserIds: jest.fn(),
  OrganizationActorError: class OrganizationActorError extends Error {
    readonly code = "ORGANIZATION_ACTOR_UNRESOLVED";
    constructor(
      readonly orgId: string,
      readonly ref: unknown,
      readonly reason: string,
    ) {
      super(`${reason}`);
      this.name = "OrganizationActorError";
    }
  },
  organizationActorHttpError: jest.fn(),
}));

jest.mock("./project-crud/project-access", () => ({
  resolveProjectAssignableMemberships: jest.fn(),
  resolveProjectAccess: jest.fn().mockResolvedValue({ hasAccess: true, role: null }),
}));

const makeUser = (overrides: Partial<CurrentUserContext> = {}): CurrentUserContext => ({
  userId: "user-caller",
  orgId: "org-1",
  role: "EMPLOYEE",
  isOrgOwner: false,
  sessionId: "sess-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
  ...overrides,
});

const makeActor = (membershipId: number) => ({
  orgId: "org-1",
  membershipId,
  userId: "user-target",
  organizationPersonId: null,
  role: "MEMBER",
  isOwner: false,
  resolvedVia: "user" as const,
});

beforeEach(() => jest.clearAllMocks());

describe("ProjectsMembersService.addMember — actor seam", () => {
  const mockDb = {
    query: {
      projects: { findFirst: jest.fn().mockResolvedValue({ id: 1, managerId: null, deletedAt: null }) },
      projectMembers: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([{ id: 10, orgId: "org-1", projectId: 1, userId: "user-target", membershipId: 42, role: "CONTRIBUTOR", joinedAt: new Date() }]),
    transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([
              { id: 10, orgId: "org-1", projectId: 1, membershipId: 42, role: "CONTRIBUTOR", joinedAt: new Date() },
            ]),
          }),
        }),
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
          }),
        }),
        execute: jest.fn().mockResolvedValue([]),
      };
      return cb(tx);
    }),
  } as unknown as Db;

  const mockAccess = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set(["build:manage"])) } as unknown as AccessService;
  const mockWebhooks = { dispatch: jest.fn(), enqueue: jest.fn() };
  const mockStates = {};
  const mockLabels = {};

  const memberDb = mockDb as unknown as {
    query: { projects: { findFirst: jest.Mock }; projectMembers: { findFirst: jest.Mock } };
    select: jest.Mock; from: jest.Mock; where: jest.Mock; limit: jest.Mock;
    insert: jest.Mock; values: jest.Mock; returning: jest.Mock;
  };

  beforeEach(() => {
    memberDb.query.projects.findFirst.mockResolvedValue({ id: 1, managerId: null, deletedAt: null });
    memberDb.query.projectMembers.findFirst.mockResolvedValue(null);
    memberDb.select.mockReturnValue(memberDb);
    memberDb.from.mockReturnValue(memberDb);
    memberDb.where.mockReturnValue(memberDb);
    memberDb.limit.mockReturnValue(memberDb);
    memberDb.insert.mockReturnValue(memberDb);
    memberDb.values.mockReturnValue(memberDb);
    memberDb.returning.mockResolvedValue([
      { id: 10, orgId: "org-1", projectId: 1, userId: "user-target", membershipId: 42, role: "CONTRIBUTOR", joinedAt: new Date() },
    ]);
    (mockAccess as unknown as { resolveUserPermissions: jest.Mock }).resolveUserPermissions.mockResolvedValue(
      new Set(["build:manage"]),
    );
  });

  const makeSvc = () =>
    new ProjectsMembersService(
      mockDb,
      mockWebhooks as never,
      mockAccess,
      mockStates as never,
      mockLabels as never,
    );

  it("reaches the actor seam at all — the project lookup must succeed first", async () => {
    (actorSeam.assertOrganizationActor as jest.Mock).mockResolvedValue(makeActor(42));

    const svc = makeSvc();
    await svc.addMember(1, { userId: "user-target", role: "CONTRIBUTOR" }, makeUser({ isOrgOwner: true }));

    expect(actorSeam.assertOrganizationActor).toHaveBeenCalledTimes(1);
  });

  it("rejects a user who is not in the organization with NotFoundException", async () => {
    const { OrganizationActorError } = actorSeam;
    const err = new OrganizationActorError("org-1", { kind: "user", userId: "user-x" }, "no-membership");
    (actorSeam.assertOrganizationActor as jest.Mock).mockRejectedValue(err);
    (actorSeam.organizationActorHttpError as jest.Mock).mockReturnValue(new NotFoundException("No such member"));

    const svc = makeSvc();
    await expect(
      svc.addMember(1, { userId: "user-x", role: "CONTRIBUTOR" }, makeUser({ isOrgOwner: true })),
    ).rejects.toThrow(NotFoundException);
  });

  it("rejects a SUSPENDED member with ForbiddenException (not NotFoundException)", async () => {
    const { OrganizationActorError } = actorSeam;
    const err = new OrganizationActorError("org-1", { kind: "user", userId: "user-x" }, "membership-inactive");
    (actorSeam.assertOrganizationActor as jest.Mock).mockRejectedValue(err);
    (actorSeam.organizationActorHttpError as jest.Mock).mockReturnValue(new ForbiddenException("Inactive"));

    const svc = makeSvc();
    await expect(
      svc.addMember(1, { userId: "user-x", role: "CONTRIBUTOR" }, makeUser({ isOrgOwner: true })),
    ).rejects.toThrow(ForbiddenException);
  });

  it("rejects a user from a different organization with NotFoundException (never ForbiddenException)", async () => {
    const { OrganizationActorError } = actorSeam;
    const err = new OrganizationActorError("org-1", { kind: "user", userId: "user-x" }, "membership-in-another-organization");
    (actorSeam.assertOrganizationActor as jest.Mock).mockRejectedValue(err);
    (actorSeam.organizationActorHttpError as jest.Mock).mockReturnValue(new NotFoundException("No such member"));

    const svc = makeSvc();
    const rejection = svc.addMember(1, { userId: "user-x", role: "CONTRIBUTOR" }, makeUser({ isOrgOwner: true }));
    await expect(rejection).rejects.toThrow(NotFoundException);
    await expect(rejection).rejects.not.toThrow(ForbiddenException);
  });

  it("writes the membershipId the actor seam resolved, and no legacy userId column", async () => {
    (actorSeam.assertOrganizationActor as jest.Mock).mockResolvedValue(makeActor(42));

    const svc = makeSvc();
    const inserted = await svc.addMember(
      1,
      { userId: "user-target", role: "CONTRIBUTOR" },
      makeUser({ isOrgOwner: true }),
    );

    expect(actorSeam.assertOrganizationActor as jest.Mock).toHaveBeenCalled();
    expect(inserted).toMatchObject({ membershipId: 42 });
    expect(inserted).not.toHaveProperty("userId");
  });

  it("throws ConflictException when the user is already a project member", async () => {
    (actorSeam.assertOrganizationActor as jest.Mock).mockResolvedValue(makeActor(42));
    (mockDb as unknown as { query: { projectMembers: { findFirst: jest.Mock } } }).query.projectMembers.findFirst.mockResolvedValue({ id: 5 });

    const svc = makeSvc();
    await expect(
      svc.addMember(1, { userId: "user-target", role: "CONTRIBUTOR" }, makeUser({ isOrgOwner: true })),
    ).rejects.toThrow(ConflictException);
  });
});

describe("ProjectsTicketsCreateService.createTicket — actor seam", () => {
  const insertChain = {
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([{
      id: 100, orgId: "org-1", projectId: 1, ticketNumber: 1,
      title: "Test", type: "TASK", status: "TODO", priority: "MEDIUM",
      assigneeId: "user-assignee", assigneeMembershipId: 7,
      reporterId: "user-caller", reporterMembershipId: 5,
      rank: "1000", completionPercentage: 0, timeSpent: "0",
      isRecurring: false, clientVisible: false, version: 1,
      createdAt: new Date(), updatedAt: new Date(),
    }]),
  };

  const txFn = jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      insert: jest.fn().mockReturnValue(insertChain),
      execute: jest.fn().mockResolvedValue([{ start: 1 }]),
      select: jest.fn().mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    };
    return cb(tx);
  });

  const mockDb = {
    query: {
      tickets: { findFirst: jest.fn().mockResolvedValue(null) },
      projects: { findFirst: jest.fn().mockResolvedValue({ id: 1, deletedAt: null, key: "PRJ" }) },
      projectMembers: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
    },
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([{ key: "PRJ" }]),
    transaction: txFn,
  } as unknown as Db;

  const mockRead = {
    checkProjectAccess: jest.fn().mockResolvedValue({ hasAccess: true, role: "MEMBER" }),
  };
  const mockQuery = {
    validateTicketStatus: jest.fn().mockResolvedValue(undefined),
  };
  const mockNotifications = { create: jest.fn() };
  const mockDispatch = { emit: jest.fn().mockResolvedValue(undefined) };
  const mockWebhooks = { dispatch: jest.fn(), enqueue: jest.fn() };
  const mockAutomation = { runForTicketEvent: jest.fn() };
  const mockCache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined), del: jest.fn().mockResolvedValue(undefined) };
  const mockAccess = { holds: jest.fn().mockResolvedValue(true) };

  const makeSvc = () =>
    new ProjectsTicketsCreateService(
      mockDb,
      mockNotifications as never,
      mockDispatch as never,
      mockQuery as never,
      mockRead as never,
      mockWebhooks as never,
      mockAutomation as never,
      mockCache as never,
      mockAccess as never,
    );

  beforeEach(() => {
    (projectAccessSeam.resolveProjectAssignableMemberships as jest.Mock).mockResolvedValue(
      new Map([["user-assignee", 7]]),
    );
    mockAccess.holds.mockResolvedValue(true);
  });

  it("rejects assignment during creation without build:tickets:assign", async () => {
    mockAccess.holds.mockResolvedValue(false);
    const svc = makeSvc();
    await expect(
      svc.createTicket(makeUser(), 1, {
        title: "My ticket",
        type: "TASK",
        assigneeId: "user-assignee",
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(actorSeam.resolveOrganizationActorsByUserIds).not.toHaveBeenCalled();
  });

  it("rejects an assignee who is not an active org member", async () => {
    (actorSeam.resolveOrganizationActorsByUserIds as jest.Mock).mockResolvedValue(
      new Map([
        ["user-caller", { membershipId: 5, userId: "user-caller" }],
      ]),
    );
    (projectAccessSeam.resolveProjectAssignableMemberships as jest.Mock).mockResolvedValue(new Map());

    const svc = makeSvc();
    await expect(
      svc.createTicket(makeUser(), 1, {
        title: "My ticket",
        type: "TASK",
        assigneeId: "user-outsider",
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it("rejects a reporter who is not an active org member", async () => {
    (actorSeam.resolveOrganizationActorsByUserIds as jest.Mock).mockResolvedValue(
      new Map([
        ["user-caller", { membershipId: 5, userId: "user-caller" }],
      ]),
    );
    const svc = makeSvc();
    await expect(
      svc.createTicket(makeUser(), 1, {
        title: "My ticket",
        type: "TASK",
        reporterId: "inactive-reporter",
      }),
    ).rejects.toThrow("Reporter is not an active member of this organization");
  });

  it("writes the resolved membership ids, and no legacy assigneeId column", async () => {
    const actorMap = new Map([
      ["user-caller", { membershipId: 5, userId: "user-caller", orgId: "org-1", role: "MEMBER", isOwner: false, organizationPersonId: null, resolvedVia: "user" as const }],
      ["user-assignee", { membershipId: 7, userId: "user-assignee", orgId: "org-1", role: "MEMBER", isOwner: false, organizationPersonId: null, resolvedVia: "user" as const }],
    ]);
    (actorSeam.resolveOrganizationActorsByUserIds as jest.Mock).mockResolvedValue(actorMap);

    const svc = makeSvc();
    await svc.createTicket(makeUser(), 1, {
      title: "My ticket",
      type: "TASK",
      assigneeId: "user-assignee",
    });

    const txCall = txFn.mock.calls[0];
    expect(txCall).toBeDefined();
    const innerInsert = insertChain.values.mock.calls[0]?.[0];
    expect(innerInsert).toMatchObject({
      assigneeMembershipId: 7,
      reporterId: "user-caller",
      reporterMembershipId: 5,
    });
    expect(innerInsert).not.toHaveProperty("assigneeId");
  });
});

describe("project-scope read — filter unchanged by actor expansion", () => {
  it("resolveProjectsScope still uses the build:manage permission key", async () => {
    const { resolveProjectsScope, PROJECTS_MANAGE_PERMISSION } = await import("./project-crud/projects-scope");
    const mockAccess = { scopeFor: jest.fn().mockResolvedValue("all") } as unknown as AccessService;
    await resolveProjectsScope(mockAccess, makeUser({ isOrgOwner: false }));
    expect(mockAccess.scopeFor).toHaveBeenCalledWith(
      expect.objectContaining({ isOrgOwner: false }),
      PROJECTS_MANAGE_PERMISSION,
    );
  });
});
