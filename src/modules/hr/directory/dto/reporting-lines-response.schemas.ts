import { z } from "zod";

const managerStateSchema = z.enum(["active", "on-notice", "inactive", "exited"]);

const reportingLineEntrySchema = z.object({
  lineId: z.number().int(),
  managerUserId: z.string().nullable(),
  managerName: z.string().nullable(),
  managerEmail: z.string().nullable(),
  managerDesignation: z.string().nullable(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  recordedAt: z.string(),
  recordedBy: z.string().nullable(),
  managerState: managerStateSchema,
});

export const reportingLineViewSchema = z.object({
  userId: z.string(),
  current: reportingLineEntrySchema.nullable(),
  upcoming: z.array(reportingLineEntrySchema),
  history: z.array(reportingLineEntrySchema),
});

export const managerCoverageReportSchema = z.object({
  generatedAt: z.string(),
  spanOfControlLimit: z.number().int(),
  summary: z.object({
    employees: z.number().int(),
    withManager: z.number().int(),
    withoutManager: z.number().int(),
    inactiveManager: z.number().int(),
    circular: z.number().int(),
    overSpan: z.number().int(),
  }),
  withoutManager: z.array(
    z.object({
      userId: z.string().nullable(),
      employmentId: z.number().int(),
      employeeNumber: z.string(),
      name: z.string().nullable(),
      email: z.string().nullable(),
      designation: z.string().nullable(),
      departmentId: z.string().nullable(),
      lifecycleStatus: z.string(),
    }),
  ),
  inactiveManager: z.array(
    z.object({
      userId: z.string().nullable(),
      name: z.string().nullable(),
      managerUserId: z.string().nullable(),
      managerName: z.string().nullable(),
      managerState: managerStateSchema,
      effectiveFrom: z.string(),
    }),
  ),
  circular: z.array(z.object({ userIds: z.array(z.string()) })),
  overSpan: z.array(
    z.object({
      managerUserId: z.string().nullable(),
      managerName: z.string().nullable(),
      directReports: z.number().int(),
    }),
  ),
});
