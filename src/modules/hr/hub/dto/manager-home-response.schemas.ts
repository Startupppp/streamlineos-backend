import { z } from "zod";
import { nullableWireDate, wireDate } from "../../../../common/openapi/wire-types";

export const managerHomeReportSchema = z.object({
  userId: z.string(),
  membershipId: z.number().int().nullable(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  designation: z.string().nullable(),
  joiningDate: z.string().nullable(),
  lifecycleStatus: z.string(),
  onLeaveToday: z.boolean(),
  probationEndsOn: z.string().nullable(),
  unsettledTimesheets: z.number().int(),
});

export const managerHomeApprovalSchema = z.object({
  kind: z.enum(["leave", "wfh", "timesheet", "workflow"]),
  id: z.number().int(),
  subjectUserId: z.string().nullable(),
  subjectName: z.string().nullable(),
  summary: z.string(),
  requestedAt: wireDate(),
  dueAt: nullableWireDate(),
  href: z.string(),
});

export const managerHomeResponseSchema = z.object({
  isManager: z.boolean(),
  generatedAt: z.string(),
  reports: z.array(managerHomeReportSchema),
  approvals: z.object({
    leave: z.number().int(),
    wfh: z.number().int(),
    timesheets: z.number().int(),
    workflows: z.number().int(),
    items: z.array(managerHomeApprovalSchema),
  }),
  missingTimesheets: z.array(
    z.object({
      periodId: z.number().int(),
      userId: z.string().nullable(),
      name: z.string().nullable(),
      periodStart: z.string(),
      periodEnd: z.string(),
      status: z.string(),
    }),
  ),
  upcomingLeave: z.array(
    z.object({
      userId: z.string(),
      name: z.string(),
      startDate: z.string(),
      endDate: z.string(),
      leaveTypeId: z.number().int().nullable(),
      status: z.enum(["PENDING", "APPROVED", "REJECTED", "CANCELLED"]),
    }),
  ),
  probationDue: z.array(z.object({ userId: z.string(), name: z.string().nullable(), probationEndDate: z.string(), daysLeft: z.number().int() })),
});

export type ManagerHome = z.infer<typeof managerHomeResponseSchema>;
export type ManagerHomeApproval = z.infer<typeof managerHomeApprovalSchema>;
