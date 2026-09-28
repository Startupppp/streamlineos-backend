import {
  gitLinkSchema,
  ticketRelationListItemSchema,
  ticketRelationSchema,
} from "../dto/build-tickets-response.schemas";

const relationListItem = {
  id: 9,
  relationType: "blocks" as const,
  direction: "outgoing" as const,
  relatedTicket: {
    id: 41,
    title: "Payment retry loops",
    ticketNumber: 128,
    status: "IN_PROGRESS",
    priority: "HIGH" as const,
    type: "BUG" as const,
    points: 3,
    version: 1,
    assigneeMembershipId: 77,
    projectId: 12,
    project: { key: "PAY" },
    assignee: {
      id: "user-1",
      name: "Priya",
      firstName: "Priya",
      lastName: null,
      email: "priya@example.com",
      image: null,
    },
  },
};

const gitLinkRow = {
  id: 3,
  provider: "github" as const,
  refType: "pull_request" as const,
  externalId: "4821",
  title: "Fix retry backoff",
  url: "https://github.com/acme/api/pull/4821",
  author: "priya",
  status: "open",
  createdAt: new Date("2026-09-20T10:00:00.000Z"),
};

describe("listRelations contract", () => {
  it("accepts the projection the service returns, which the raw-row schema rejected outright", () => {
    expect(() => ticketRelationListItemSchema.parse(relationListItem)).not.toThrow();
    expect(() => ticketRelationSchema.parse(relationListItem)).toThrow();
  });

  it("keeps relationType, direction and relatedTicket, the three fields a raw-row schema stripped from every row", () => {
    const parsed = ticketRelationListItemSchema.parse(relationListItem);
    expect(parsed.relationType).toBe("blocks");
    expect(parsed.direction).toBe("outgoing");
    expect(parsed.relatedTicket.ticketNumber).toBe(128);
  });

  it("carries a null assignee rather than dropping the key, because the service maps an unassigned related ticket to null", () => {
    const unassigned = {
      ...relationListItem,
      relatedTicket: { ...relationListItem.relatedTicket, assignee: null },
    };
    expect(ticketRelationListItemSchema.parse(unassigned).relatedTicket.assignee).toBeNull();
  });

  it("rejects a related ticket with no version, because the board inline edit cannot send a token the list never gave it", () => {
    expect(() =>
      ticketRelationListItemSchema.parse({
        ...relationListItem,
        relatedTicket: { ...relationListItem.relatedTicket, version: undefined },
      }),
    ).toThrow();
  });

  it("rejects a relationType outside the work_item_relation_type enum, so a widened column cannot pass silently", () => {
    expect(() =>
      ticketRelationListItemSchema.parse({ ...relationListItem, relationType: "supersedes" }),
    ).toThrow();
  });
});

describe("addRelation contract", () => {
  it("declares relationType, which the inserted row returns and the schema previously omitted and stripped", () => {
    const created = {
      id: 9,
      orgId: "org-1",
      workItemId: 41,
      relatedWorkItemId: 42,
      relationType: "relates_to" as const,
      createdAt: new Date("2026-09-20T10:00:00.000Z"),
    };
    expect(ticketRelationSchema.parse(created).relationType).toBe("relates_to");
  });
});

describe("getGitLinks contract", () => {
  it("matches the service projection, where every field the old schema required was absent", () => {
    expect(() => gitLinkSchema.parse(gitLinkRow)).not.toThrow();
  });

  it("names the column url rather than repoUrl, so the link the row carries is the link that reaches the client", () => {
    expect(gitLinkSchema.parse(gitLinkRow).url).toBe("https://github.com/acme/api/pull/4821");
  });

  it("allows the nullable text columns to be null, because title, url, author and status have no NOT NULL", () => {
    const sparse = { ...gitLinkRow, title: null, url: null, author: null, status: null };
    expect(() => gitLinkSchema.parse(sparse)).not.toThrow();
  });

  it("rejects a provider outside the git_provider enum, so a new provider cannot ship without updating the contract", () => {
    expect(() => gitLinkSchema.parse({ ...gitLinkRow, provider: "gitea" })).toThrow();
  });
});
