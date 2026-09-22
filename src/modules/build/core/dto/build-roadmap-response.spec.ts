import { roadmapItemSchema, feedbackPostSchema } from "./build-roadmap-response.schemas";
import { roadmapStatusEnum, feedbackStatusEnum } from "../../../../db/schema";

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
