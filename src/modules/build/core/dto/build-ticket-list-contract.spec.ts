import {
  allWorkPageSchema,
  ticketListPageSchema,
  ticketRowSchema,
  ticketSearchResultListSchema,
} from "./build-tickets-response.schemas";

const user = { id: "user-1", name: "Member", firstName: "Member", lastName: null, email: "member@example.test", image: null };
const row = {
  id: 1, orgId: "org-1", title: "Ticket", type: "BUG", status: "OPEN", priority: "HIGH",
  projectId: 42, ticketNumber: 1, epicId: null, assigneeMembershipId: 7,
  reporterId: null, points: null, storyPoints: null, link: null, rank: "a0", parentTicketId: null,
  originalEstimate: null, timeSpent: "0", startDate: null, dueDate: null, moduleId: null,
  cycleId: null, sequenceId: null, estimate: null, version: 1, createdAt: new Date(), updatedAt: new Date(),
  descriptionExcerpt: "A short plain-text excerpt of the ticket body",
  assigneeId: user.id, assignee: user, assignees: [{ id: 1, ticketId: 1, assignedAt: new Date(), assignedBy: null, userId: user.id, user }],
  labels: [{ id: 1, ticketId: 1, labelId: 3, createdAt: new Date(), label: { id: 3, orgId: "org-1", createdAt: new Date(), name: "Bug", color: null } }], cycle: null,
};

describe("Build ticket list projection contract", () => {
  it("accepts the bounded ticket search projection", () => {
    const result = ticketSearchResultListSchema.parse([
      {
        id: 2,
        title: "Regression Epic",
        status: "TODO",
        priority: "MEDIUM",
        ticketNumber: 2,
        projectId: 5,
        projectKey: "LBR",
        projectName: "Local Build Regression",
      },
    ]);

    expect(result).toHaveLength(1);
  });

  it("accepts the actual cross-project work projection and requires rendered fields", () => {
    const work = { id: 1, title: "Ticket", type: "BUG", status: "OPEN", priority: "HIGH", projectId: 42, projectKey: "BUILD", projectName: "Project", ticketNumber: 1, dueDate: null, startDate: null, points: null, estimate: null, rank: "a0", version: 2, cycleId: null, epicId: null, assigneeId: user.id, assignee: user, labels: [], createdAt: new Date(), updatedAt: new Date() };
    const page = { data: [work], limit: 25, nextCursor: null, hasMore: false };
    expect(allWorkPageSchema.parse(page).data[0]).toEqual(work);
    expect(allWorkPageSchema.safeParse({ ...page, data: [{ ...work, projectName: undefined }] }).success).toBe(false);
  });

  it("rejects an all-work row with no version, because the board inline edit cannot send a token the list never gave it", () => {
    const work = { id: 1, title: "Ticket", type: "BUG", status: "OPEN", priority: "HIGH", projectId: 42, projectKey: "BUILD", projectName: "Project", ticketNumber: 1, dueDate: null, startDate: null, points: null, estimate: null, rank: "a0", version: 2, cycleId: null, epicId: null, assigneeId: user.id, assignee: user, labels: [], createdAt: new Date(), updatedAt: new Date() };
    const page = { data: [work], limit: 25, nextCursor: null, hasMore: false };
    expect(allWorkPageSchema.safeParse({ ...page, data: [{ ...work, version: undefined }] }).success).toBe(false);
  });
  it("accepts the bounded light projection without demanding detail-only columns", () => {
    const result = ticketListPageSchema.parse({ data: [row], pagination: { limit: 25, hasMore: false, nextCursor: null } });
    expect(result.data[0]?.assignee).toEqual(user);
    expect(result.data[0]?.labels[0]?.label?.name).toBe("Bug");
    expect(result.data[0]).not.toHaveProperty("description");
    expect(ticketRowSchema.safeParse(row).success).toBe(false);
  });

  it.each(["title", "rank", "assigneeMembershipId", "createdAt", "assignees", "labels", "version"])("rejects missing required projected %s", (field) => {
    const incomplete = Object.fromEntries(Object.entries(row).filter(([key]) => key !== field));
    expect(ticketListPageSchema.safeParse({ data: [incomplete], pagination: { limit: 25, hasMore: false, nextCursor: null } }).success).toBe(false);
  });

  it("projects the concurrency token, because a board inline edit cannot send a token the list never gave it and the ticket PATCH body requires one", () => {
    const parsed = ticketListPageSchema.parse({ data: [row], pagination: { limit: 25, hasMore: false, nextCursor: null } });

    expect(parsed.data[0]?.version).toBe(1);
  });

  it("rejects membership IDs impersonating user summaries", () => {
    expect(ticketListPageSchema.safeParse({ data: [{ ...row, assignee: { id: 7 } }], pagination: { limit: 25, hasMore: false, nextCursor: null } }).success).toBe(false);
  });
});
