import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { successSchema } from "../../../../common/openapi/response-envelopes";

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
  priority: z.string(),
  component: z.string().nullable(),
  linkedTicketId: z.number().int().nullable(),
  automationStatus: z.string(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

export const testRunRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  runNumber: z.number().int(),
  name: z.string(),
  sprintId: z.number().int().nullable(),
  releaseId: z.number().int().nullable(),
  environment: z.string().nullable(),
  browserDevice: z.string().nullable(),
  testerId: z.string().nullable(),
  testerMembershipId: z.number().int().nullable(),
  status: z.string(),
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

export const testRunResultRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  runId: z.number().int(),
  testCaseId: z.number().int(),
  status: z.string(),
  notes: z.string().nullable(),
  executedBy: z.string().nullable(),
  executedAt: nullableWireDate(),
  linkedBugId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const testRunDetailSchema = testRunRowSchema.extend({
  results: z.array(testRunResultRowSchema),
});

export const bugRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  bugNumber: z.number().int(),
  title: z.string(),
  description: z.string().nullable(),
  severity: z.string(),
  priority: z.string(),
  status: z.string(),
  stepsToReproduce: z.string().nullable(),
  expectedResult: z.string().nullable(),
  actualResult: z.string().nullable(),
  environment: z.string().nullable(),
  browserDevice: z.string().nullable(),
  affectedReleaseId: z.number().int().nullable(),
  fixedReleaseId: z.number().int().nullable(),
  assigneeMembershipId: z.number().int().nullable(),
  reporterId: z.string().nullable(),
  qaOwnerId: z.string().nullable(),
  qaOwnerMembershipId: z.number().int().nullable(),
  reopenCount: z.number().int(),
  linkedTicketId: z.number().int().nullable(),
  linkedTestCaseId: z.number().int().nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

export { successSchema };
