import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

export const testSuiteRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
  parentId: z.number().int().nullable(),
  position: z.number().int(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

export const testSuiteWithCaseCountSchema = testSuiteRowSchema.extend({
  caseCount: z.number().int(),
});

export const testCaseRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  suiteId: z.number().int().nullable(),
  caseNumber: z.number().int(),
  title: z.string(),
  preconditions: z.string().nullable(),
  steps: z.unknown(),
  expectedResult: z.string().nullable(),
  priority: z.enum(["low", "medium", "high"]),
  component: z.string().nullable(),
  linkedTicketId: z.number().int().nullable(),
  automationStatus: z.enum(["manual", "automated", "planned"]),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

export const testCasePageSchema = z.object({
  data: z.array(testCaseRowSchema),
  hasMore: z.boolean(),
  nextCursor: z.number().int().nullable(),
});

export const testRunRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  runNumber: z.number().int(),
  name: z.string(),
  cycleId: z.number().int().nullable(),
  releaseId: z.number().int().nullable(),
  environment: z.string().nullable(),
  browserDevice: z.string().nullable(),
  testerId: z.string().nullable(),
  testerMembershipId: z.number().int().nullable(),
  status: z.enum(["not_started", "in_progress", "completed", "aborted"]),
  startedAt: nullableWireDate(),
  completedAt: nullableWireDate(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

export const testRunListItemSchema = testRunRowSchema.extend({
  passCount: z.number().int(),
  failCount: z.number().int(),
  blockedCount: z.number().int(),
  notRunCount: z.number().int(),
  skippedCount: z.number().int(),
});

export const testRunListPageSchema = z.object({
  data: z.array(testRunListItemSchema),
  hasMore: z.boolean(),
  nextCursor: z.number().int().nullable(),
});

export const testRunResultRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  runId: z.number().int(),
  testCaseId: z.number().int(),
  status: z.enum(["not_run", "passed", "failed", "blocked", "skipped"]),
  notes: z.string().nullable(),
  executedBy: z.string().nullable(),
  executedAt: nullableWireDate(),
  linkedWorkItemId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const testRunResultPageSchema = z.object({
  data: z.array(testRunResultRowSchema),
  hasMore: z.boolean(),
  nextCursor: z.number().int().nullable(),
});

export const testRunDetailSchema = testRunRowSchema.extend({
  results: z.array(testRunResultRowSchema),
});

export const bugRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  ticketNumber: z.number().int(),
  title: z.string(),
  description: z.string().nullable(),
  type: z.literal("BUG"),
  status: z.string(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]),
  assigneeMembershipId: z.number().int().nullable(),
  reporterId: z.string().nullable(),
  deletedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  qaState: z.enum(["new", "triaged", "assigned", "in_progress", "fixed", "ready_for_qa", "verified", "reopened", "closed"]).nullable(),
  severity: z.enum(["blocker", "critical", "major", "minor", "trivial"]).nullable(),
  stepsToReproduce: z.string().nullable(),
  expectedResult: z.string().nullable(),
  actualResult: z.string().nullable(),
  environment: z.string().nullable(),
  browserDevice: z.string().nullable(),
  affectedReleaseId: z.number().int().nullable(),
  fixedReleaseId: z.number().int().nullable(),
  qaOwnerUserId: z.string().nullable(),
  qaOwnerMembershipId: z.number().int().nullable(),
  linkedTestCaseId: z.number().int().nullable(),
  reopenCount: z.number().int().nullable(),
  createdByUserId: z.string().nullable(),
});
