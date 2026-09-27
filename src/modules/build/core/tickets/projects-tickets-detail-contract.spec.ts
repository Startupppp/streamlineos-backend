import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { AccessService } from "../../../access/access.service";
import { AuditService } from "../../../../common/audit/audit.service";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { ticketDetailSchema } from "../dto/build-tickets-response.schemas";
import { ProjectsTicketsDetailService } from "./projects-tickets-detail.service";

const actor: CurrentUserContext = { userId: "user-1", orgId: "org-1", role: "OWNER", isOrgOwner: true, sessionId: "test", tokenScopes: null, principal: humanSessionPrincipal(1, true) };
const user = { id: "user-1", name: "Member", firstName: "Member", lastName: null, email: "member@example.test", image: null };
const row = {
  id: 1, orgId: "org-1", title: "Ticket", description: null, type: "BUG", status: "OPEN", priority: "HIGH",
  projectId: 42, ticketNumber: 101, sprintId: null, epicId: 2, assigneeMembershipId: 1, reporterId: null,
  reporterMembershipId: null, points: null, storyPoints: null, link: null, rank: "a0", parentTicketId: null,
  originalEstimate: null, timeSpent: "0", startDate: null, dueDate: null, moduleId: null, cycleId: null,
  sequenceId: null, estimate: null, completionPercentage: 0, clientVisible: false, isRecurring: false,
  recurrenceRule: null, recurrenceParentId: null, recurrenceNextRunAt: null, customerId: null,
  version: 1, deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
  project: { id: 42, orgId: "org-1", name: "Project", key: "BUILD" }, sprint: null,
  assignee: { user }, reporter: null, assignees: [{ id: 5, ticketId: 1, assignedAt: new Date(), assignedBy: null, user: { userId: user.id, user } }],
  watchers: [{ user: { user } }],
  comments: [{
    id: 9, orgId: "org-1", ticketId: 1, userId: "user-1", content: "hi",
    parentCommentId: null, createdAt: new Date(), updatedAt: new Date(),
    user, reactions: [{ emoji: "👍", membership: { userId: "user-1" } }],
  }],
  attachments: [{ id: 3, fileName: "notes.txt", fileUrl: "https://example.test/notes", uploader: user }],
  labels: [{ label: { id: 4, name: "Bug", color: null } }],
};

it.each(["id", "key"])("returns the complete existing detail contract for %s lookup", async (lookup) => {
  const findFirst = jest.fn().mockResolvedValueOnce(row).mockResolvedValueOnce({ id: 2, title: "Epic" });
  const module = await Test.createTestingModule({ providers: [
    ProjectsTicketsDetailService,
    {
      provide: DRIZZLE,
      useValue: {
        query: {
          tickets: { findFirst },
          projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: null }) },
        },
      },
    },
    { provide: AccessService, useValue: { scopeFor: jest.fn().mockResolvedValue("all") } },
    { provide: AuditService, useValue: { log: jest.fn() } },
  ] }).compile();
  try {
    const service = module.get(ProjectsTicketsDetailService);
    const result = lookup === "id" ? await service.getTicket(actor, 42, 1) : await service.getTicketByKey(actor, 42, 101);
    const parsed = ticketDetailSchema.parse(result);
    expect(parsed.epic).toEqual({ id: 2, name: "Epic" });
    expect(parsed.assignees[0]?.user).toEqual({ userId: user.id, user });
    expect(parsed.members[0]?.user.user).toEqual(user);
    expect(parsed.watchers[0]?.user).toEqual(user);
    expect(parsed.attachments[0]).toMatchObject({ filename: "notes.txt", url: "https://example.test/notes" });
    expect(parsed.labels[0]?.name).toBe("Bug");
    expect(parsed.comments[0]?.reactions).toEqual([{ emoji: "👍", userId: "user-1" }]);
    expect(findFirst).toHaveBeenCalledTimes(2);
  } finally { await module.close(); }
});

it("bounds every ticket detail collection that can grow independently", async () => {
  const findFirst = jest.fn().mockResolvedValueOnce(row).mockResolvedValueOnce({ id: 2, title: "Epic" });
  const module = await Test.createTestingModule({ providers: [
    ProjectsTicketsDetailService,
    {
      provide: DRIZZLE,
      useValue: {
        query: {
          tickets: { findFirst },
          projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: null }) },
        },
      },
    },
    { provide: AccessService, useValue: { scopeFor: jest.fn().mockResolvedValue("all") } },
    { provide: AuditService, useValue: { log: jest.fn() } },
  ] }).compile();
  try {
    const service = module.get(ProjectsTicketsDetailService);
    await service.getTicket(actor, 42, 1);
    const relationConfig = findFirst.mock.calls[0]?.[0]?.with as Record<string, { limit?: number }>;
    expect(relationConfig.assignees?.limit).toBe(100);
    expect(relationConfig.watchers?.limit).toBe(100);
    expect(relationConfig.comments?.limit).toBe(50);
    expect(relationConfig.attachments?.limit).toBe(100);
    expect(relationConfig.labels?.limit).toBe(100);
  } finally { await module.close(); }
});
