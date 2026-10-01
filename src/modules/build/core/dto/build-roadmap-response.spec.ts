import {
  roadmapItemSchema,
  feedbackPostSchema,
  roadmapPageSchema,
  templateRowSchema,
  applyTemplateResultSchema,
} from "./build-roadmap-response.schemas";
import { roadmapStatusEnum, feedbackStatusEnum } from "../../../../db/schema";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";
import { roadmapListQuerySchema, feedbackListQuerySchema } from "./roadmap.schemas";

const NOW = new Date();

function roadmapBase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    orgId: "org-1",
    title: "Improve onboarding",
    description: null,
    category: null,
    isPublic: true,
    projectId: null,
    epicTicketId: null,
    targetQuarter: null,
    sortOrder: 0,
    votes: 0,
    reach: null,
    impact: null,
    confidence: null,
    effort: null,
    outcome: null,
    ownerMembershipId: null,
    owner: null,
    version: 1,
    createdBy: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function feedbackBase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    orgId: "org-1",
    title: "Login is broken",
    description: null,
    category: null,
    votes: 0,
    submittedByName: null,
    submittedByEmail: null,
    crmContactId: null,
    crmOrganizationId: null,
    accountValueSnapshot: null,
    accountTierSnapshot: null,
    linkedRoadmapItemId: null,
    duplicateOfId: null,
    mergedAt: null,
    createdBy: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

describe("roadmapItemSchema — status field", () => {
  it("accepts every value in roadmapStatusEnum", () => {
    for (const value of roadmapStatusEnum.enumValues) {
      expect(() => roadmapItemSchema.parse(roadmapBase({ status: value }))).not.toThrow();
    }
  });

  it("rejects a status value that is not in roadmapStatusEnum", () => {
    expect(() => roadmapItemSchema.parse(roadmapBase({ status: "unknown_status" }))).toThrow();
  });

  it("rejects a null status because the column is NOT NULL", () => {
    expect(() => roadmapItemSchema.parse(roadmapBase({ status: null }))).toThrow();
  });

  it("rejects a row with no status field at all", () => {
    const raw = roadmapBase();
    delete raw.status;
    expect(() => roadmapItemSchema.parse(raw)).toThrow();
  });
});

describe("roadmapItemSchema — version field", () => {
  it("rejects a roadmap item with no version, because the board inline edit cannot send a token the list never gave it", () => {
    const raw = roadmapBase();
    delete raw.version;
    expect(() => roadmapItemSchema.parse(raw)).toThrow();
  });
});

describe("feedbackPostSchema — status field", () => {
  it("accepts every value in feedbackStatusEnum", () => {
    for (const value of feedbackStatusEnum.enumValues) {
      expect(() => feedbackPostSchema.parse(feedbackBase({ status: value }))).not.toThrow();
    }
  });

  it("rejects a status value that is not in feedbackStatusEnum", () => {
    expect(() => feedbackPostSchema.parse(feedbackBase({ status: "invalid_status" }))).toThrow();
  });

  it("rejects a null status because the column is NOT NULL", () => {
    expect(() => feedbackPostSchema.parse(feedbackBase({ status: null }))).toThrow();
  });

  it("rejects a row with no status field at all", () => {
    const raw = feedbackBase();
    delete raw.status;
    expect(() => feedbackPostSchema.parse(raw)).toThrow();
  });
});

describe("roadmapPageSchema — status passes through the data envelope", () => {
  it("preserves status on each item in the data array", () => {
    const parsed = roadmapPageSchema.parse({
      data: [roadmapBase({ status: "in_progress" })],
      pagination: { limit: 5, hasMore: false, nextCursor: null },
    });
    expect(parsed.data[0].status).toBe("in_progress");
  });

  it("rejects a page where a data item carries an unknown status", () => {
    expect(() =>
      roadmapPageSchema.parse({
        data: [roadmapBase({ status: "archived" })],
        pagination: { limit: 5, hasMore: false, nextCursor: null },
      })
    ).toThrow();
  });
});

describe("cursorPageSchema(feedbackPostSchema) — status passes through the data envelope", () => {
  const feedbackPageSchema = cursorPageSchema(feedbackPostSchema);

  it("preserves status on each item in the data array", () => {
    const parsed = feedbackPageSchema.parse({
      data: [feedbackBase({ status: "declined" })],
      pagination: { limit: 5, hasMore: false, nextCursor: null },
    });
    expect(parsed.data[0].status).toBe("declined");
  });

  it("rejects a page where a data item carries an unknown status", () => {
    expect(() =>
      feedbackPageSchema.parse({
        data: [feedbackBase({ status: "spam" })],
        pagination: { limit: 5, hasMore: false, nextCursor: null },
      })
    ).toThrow();
  });
});

describe("templateRowSchema accepts the shape createTemplate returns including tickets", () => {
  const base = {
    id: 1,
    orgId: "org-1",
    name: "Sprint template",
    description: null,
    category: "general",
    createdBy: null,
    deletedAt: null,
    createdAt: NOW,
  };

  it("accepts a template with an empty tickets array so a newly created template with no ticket stubs parses", () => {
    expect(() => templateRowSchema.parse({ ...base, tickets: [] })).not.toThrow();
  });

  it("accepts a template with ticket stubs so createTemplate responses are fully declared", () => {
    const ticket = {
      id: 10,
      templateId: 1,
      title: "Write tests",
      description: null,
      type: "TASK",
      priority: "MEDIUM",
      estimatedHours: null,
      order: 0,
      phase: null,
    };
    expect(() => templateRowSchema.parse({ ...base, tickets: [ticket] })).not.toThrow();
  });

  it("preserves tickets in the parsed value so the FE receives the template stubs in one response", () => {
    const parsed = templateRowSchema.parse({ ...base, tickets: [] });
    expect(Array.isArray(parsed.tickets)).toBe(true);
  });
});

describe("applyTemplateResultSchema accepts the shape applyTemplate returns", () => {
  it("accepts projectId, key, ticketsCreated so the response contract matches the service output", () => {
    expect(() =>
      applyTemplateResultSchema.parse({ projectId: 1, key: "PRJ-001", ticketsCreated: 5 })
    ).not.toThrow();
  });

  it("preserves all three fields so the FE can redirect to the new project without a second request", () => {
    const parsed = applyTemplateResultSchema.parse({ projectId: 2, key: "PROJ-123", ticketsCreated: 0 });
    expect(parsed).toEqual({ projectId: 2, key: "PROJ-123", ticketsCreated: 0 });
  });

  it("rejects the old project+tickets envelope because the service no longer returns it", () => {
    expect(() =>
      applyTemplateResultSchema.parse({
        project: { id: 1, name: "P", key: "K" },
        tickets: [{ id: 1, title: "T" }],
      })
    ).toThrow();
  });
});

describe("filter status enum matches pgEnum — drift protection", () => {
  it("roadmap filter status options equal roadmapStatusEnum.enumValues exactly", () => {
    const filterStatus = roadmapListQuerySchema.shape.status.unwrap();
    expect([...filterStatus.options].sort()).toEqual([...roadmapStatusEnum.enumValues].sort());
  });

  it("feedback filter status options equal feedbackStatusEnum.enumValues exactly", () => {
    const filterStatus = feedbackListQuerySchema.shape.status.unwrap();
    expect([...filterStatus.options].sort()).toEqual([...feedbackStatusEnum.enumValues].sort());
  });
});
