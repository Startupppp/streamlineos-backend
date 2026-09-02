import { z } from "zod";

const testCaseStepSchema = z.object({
  action: z.string().min(1),
  expected: z.string().min(1),
});

export const createTestSuiteSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  parentId: z.number().int().positive().optional(),
}).strict();

export const updateTestSuiteSchema = createTestSuiteSchema.partial().strict();

export const testCaseListQuerySchema = z.object({
  suiteId: z.coerce.number().int().positive().optional(),
  q: z.string().optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  automationStatus: z.enum(["manual", "automated", "planned"]).optional(),
}).strict();

export const createTestCaseSchema = z.object({
  suiteId: z.number().int().positive().optional(),
  title: z.string().min(1).max(500),
  preconditions: z.string().optional(),
  steps: z.array(testCaseStepSchema).optional(),
  expectedResult: z.string().optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  component: z.string().optional(),
  linkedTicketId: z.number().int().positive().optional(),
  automationStatus: z.enum(["manual", "automated", "planned"]).optional(),
}).strict();

export const updateTestCaseSchema = createTestCaseSchema.partial().strict();

export const testRunListQuerySchema = z.object({
  status: z.enum(["not_started", "in_progress", "completed", "aborted"]).optional(),
}).strict();

export const createTestRunSchema = z.object({
  name: z.string().min(1).max(500),
  sprintId: z.number().int().positive().optional(),
  releaseId: z.number().int().positive().optional(),
  environment: z.string().optional(),
  browserDevice: z.string().optional(),
  testerId: z.string().optional(),
  caseIds: z.array(z.number().int().positive()).max(500).optional(),
  suiteId: z.number().int().positive().optional(),
}).strict();

export const updateTestRunSchema = z.object({
  name: z.string().min(1).max(500).optional(),
  status: z.enum(["not_started", "in_progress", "completed", "aborted"]).optional(),
  environment: z.string().optional(),
  browserDevice: z.string().optional(),
  testerId: z.string().optional(),
  sprintId: z.number().int().positive().optional(),
  releaseId: z.number().int().positive().optional(),
}).strict();

export const updateTestResultSchema = z.object({
  status: z.enum(["not_run", "passed", "failed", "blocked", "skipped"]),
  notes: z.string().optional(),
}).strict();

export const createBugFromResultSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  severity: z.enum(["blocker", "critical", "major", "minor", "trivial"]).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  assigneeId: z.string().optional(),
  description: z.string().optional(),
  expectedResult: z.string().optional(),
  actualResult: z.string().optional(),
  environment: z.string().optional(),
  browserDevice: z.string().optional(),
}).strict();

export type CreateTestSuiteInput = z.infer<typeof createTestSuiteSchema>;
export type UpdateTestSuiteInput = z.infer<typeof updateTestSuiteSchema>;
export type TestCaseListQuery = z.infer<typeof testCaseListQuerySchema>;
export type CreateTestCaseInput = z.infer<typeof createTestCaseSchema>;
export type UpdateTestCaseInput = z.infer<typeof updateTestCaseSchema>;
export type TestRunListQuery = z.infer<typeof testRunListQuerySchema>;
export type CreateTestRunInput = z.infer<typeof createTestRunSchema>;
export type UpdateTestRunInput = z.infer<typeof updateTestRunSchema>;
export type UpdateTestResultInput = z.infer<typeof updateTestResultSchema>;
export type CreateBugFromResultInput = z.infer<typeof createBugFromResultSchema>;
