import { z } from "zod";

export const HR_AUTOMATION_EVENTS = [
  "employee.created",
  "employee.onboarded",
  "employee.probation_due",
  "employee.confirmed",
  "employee.transferred",
  "employee.promoted",
  "employee.salary_revised",
  "leave.requested",
  "leave.approved",
  "attendance.late",
  "attendance.missed_punch",
  "document.expiring",
  "asset.assigned",
  "asset.return_due",
  "review.cycle_started",
  "review.due",
  "goal.overdue",
  "course.assigned",
  "resignation.submitted",
  "exit.completed",
  "employee.updated",
  "employee.exited",
  "contract.ended",
  "attendance.finalized",
  "payroll.inputs_locked",
] as const;

export type HrAutomationEvent = (typeof HR_AUTOMATION_EVENTS)[number];

export const hrAutomationEventSchema = z.enum(HR_AUTOMATION_EVENTS);

export interface EventFieldDoc {
  field: string;
  label: string;
  type: "string" | "number" | "boolean" | "date";
}

export const HR_EVENT_FIELD_DOCS: Record<HrAutomationEvent, EventFieldDoc[]> = {
  "employee.created": [
    { field: "employeeId", label: "Employee ID", type: "string" },
    { field: "departmentId", label: "Department ID", type: "number" },
    { field: "locationId", label: "Location ID", type: "number" },
    { field: "employmentType", label: "Employment Type", type: "string" },
    { field: "roleId", label: "Role ID", type: "number" },
    { field: "salaryBand", label: "Salary Band", type: "string" },
  ],
  "employee.onboarded": [
    { field: "employeeId", label: "Employee ID", type: "string" },
    { field: "departmentId", label: "Department ID", type: "number" },
    { field: "onboardingDays", label: "Onboarding Duration (days)", type: "number" },
  ],
  "employee.probation_due": [
    { field: "employeeId", label: "Employee ID", type: "string" },
    { field: "daysUntilEnd", label: "Days Until End", type: "number" },
    { field: "departmentId", label: "Department ID", type: "number" },
  ],
  "employee.confirmed": [
    { field: "employeeId", label: "Employee ID", type: "string" },
    { field: "departmentId", label: "Department ID", type: "number" },
    { field: "salaryBand", label: "Salary Band", type: "string" },
  ],
  "employee.transferred": [
    { field: "employeeId", label: "Employee ID", type: "string" },
    { field: "fromDepartmentId", label: "From Department", type: "number" },
    { field: "toDepartmentId", label: "To Department", type: "number" },
    { field: "fromLocationId", label: "From Location", type: "number" },
    { field: "toLocationId", label: "To Location", type: "number" },
  ],
  "employee.promoted": [
    { field: "employeeId", label: "Employee ID", type: "string" },
    { field: "fromRoleId", label: "From Role", type: "number" },
    { field: "toRoleId", label: "To Role", type: "number" },
    { field: "salaryBand", label: "Salary Band", type: "string" },
  ],
  "employee.salary_revised": [
    { field: "employeeId", label: "Employee ID", type: "string" },
    { field: "previousAmount", label: "Previous Amount", type: "number" },
    { field: "newAmount", label: "New Amount", type: "number" },
    { field: "salaryBand", label: "Salary Band", type: "string" },
  ],
  "leave.requested": [
    { field: "employeeId", label: "Employee ID", type: "string" },
    { field: "leaveType", label: "Leave Type", type: "string" },
    { field: "days", label: "Days Requested", type: "number" },
    { field: "departmentId", label: "Department ID", type: "number" },
  ],
  "leave.approved": [
    { field: "employeeId", label: "Employee ID", type: "string" },
    { field: "leaveType", label: "Leave Type", type: "string" },
    { field: "days", label: "Days Approved", type: "number" },
  ],
  "attendance.late": [
    { field: "employeeId", label: "Employee ID", type: "string" },
    { field: "minutesLate", label: "Minutes Late", type: "number" },
    { field: "departmentId", label: "Department ID", type: "number" },
    { field: "attendanceStatus", label: "Attendance Status", type: "string" },
  ],
  "attendance.missed_punch": [
    { field: "employeeId", label: "Employee ID", type: "string" },
    { field: "date", label: "Date", type: "date" },
    { field: "departmentId", label: "Department ID", type: "number" },
  ],
  "document.expiring": [
    { field: "employeeId", label: "Employee ID", type: "string" },
    { field: "documentType", label: "Document Type", type: "string" },
    { field: "daysUntilExpiry", label: "Days Until Expiry", type: "number" },
  ],
  "asset.assigned": [
    { field: "employeeId", label: "Employee ID", type: "string" },
    { field: "assetType", label: "Asset Type", type: "string" },
    { field: "assetId", label: "Asset ID", type: "number" },
  ],
  "asset.return_due": [
    { field: "employeeId", label: "Employee ID", type: "string" },
    { field: "assetType", label: "Asset Type", type: "string" },
    { field: "daysUntilDue", label: "Days Until Due", type: "number" },
  ],
  "review.cycle_started": [
    { field: "cycleId", label: "Cycle ID", type: "number" },
    { field: "cycleName", label: "Cycle Name", type: "string" },
    { field: "departmentId", label: "Department ID", type: "number" },
  ],
  "review.due": [
    { field: "cycleId", label: "Cycle ID", type: "number" },
    { field: "cycleName", label: "Cycle Name", type: "string" },
    { field: "deadline", label: "Deadline", type: "string" },
  ],
  "goal.overdue": [
    { field: "employeeId", label: "Employee ID", type: "string" },
    { field: "goalId", label: "Goal ID", type: "number" },
    { field: "daysPastDue", label: "Days Past Due", type: "number" },
  ],
  "course.assigned": [
    { field: "employeeId", label: "Employee ID", type: "string" },
    { field: "courseId", label: "Course ID", type: "number" },
    { field: "courseName", label: "Course Name", type: "string" },
  ],
  "resignation.submitted": [
    { field: "employeeId", label: "Employee ID", type: "string" },
    { field: "lastWorkingDate", label: "Last Working Date", type: "date" },
    { field: "departmentId", label: "Department ID", type: "number" },
    { field: "noticePeriodDays", label: "Notice Period (days)", type: "number" },
  ],
  "exit.completed": [
    { field: "employeeId", label: "Employee ID", type: "string" },
    { field: "exitType", label: "Exit Type", type: "string" },
    { field: "departmentId", label: "Department ID", type: "number" },
    { field: "tenure", label: "Tenure (months)", type: "number" },
  ],
  "employee.updated": [
    { field: "employeeId", label: "Employee ID", type: "string" },
    { field: "changedFields", label: "Changed Fields", type: "string" },
    { field: "departmentId", label: "Department ID", type: "number" },
  ],
  "employee.exited": [
    { field: "employeeId", label: "Employee ID", type: "string" },
    { field: "exitType", label: "Exit Type", type: "string" },
    { field: "lastWorkingDate", label: "Last Working Date", type: "date" },
    { field: "departmentId", label: "Department ID", type: "number" },
  ],
  "contract.ended": [
    { field: "employeeId", label: "Employee ID", type: "string" },
    { field: "contractId", label: "Contract ID", type: "number" },
    { field: "contractType", label: "Contract Type", type: "string" },
  ],
  "attendance.finalized": [
    { field: "employeeId", label: "Employee ID", type: "string" },
    { field: "periodMonth", label: "Period Month (YYYY-MM)", type: "string" },
    { field: "totalDays", label: "Total Days", type: "number" },
    { field: "presentDays", label: "Present Days", type: "number" },
  ],
  "payroll.inputs_locked": [
    { field: "periodMonth", label: "Period Month (YYYY-MM)", type: "string" },
    { field: "lockedBy", label: "Locked By (userId)", type: "string" },
    { field: "employeeCount", label: "Employee Count", type: "number" },
  ],
};

export const HR_EVENT_SAMPLE_PAYLOADS: Record<HrAutomationEvent, Record<string, unknown>> = {
  "employee.created": { employeeId: "user_abc123", departmentId: 1, locationId: 1, employmentType: "full_time", roleId: 3, salaryBand: "L3" },
  "employee.onboarded": { employeeId: "user_abc123", departmentId: 1, onboardingDays: 14 },
  "employee.probation_due": { employeeId: "user_abc123", daysUntilEnd: 7, departmentId: 1 },
  "employee.confirmed": { employeeId: "user_abc123", departmentId: 1, salaryBand: "L3" },
  "employee.transferred": { employeeId: "user_abc123", fromDepartmentId: 1, toDepartmentId: 2, fromLocationId: 1, toLocationId: 2 },
  "employee.promoted": { employeeId: "user_abc123", fromRoleId: 3, toRoleId: 4, salaryBand: "L4" },
  "employee.salary_revised": { employeeId: "user_abc123", previousAmount: 50000, newAmount: 60000, salaryBand: "L4" },
  "leave.requested": { employeeId: "user_abc123", leaveType: "annual", days: 3, departmentId: 1 },
  "leave.approved": { employeeId: "user_abc123", leaveType: "annual", days: 3 },
  "attendance.late": { employeeId: "user_abc123", minutesLate: 25, departmentId: 1, attendanceStatus: "late" },
  "attendance.missed_punch": { employeeId: "user_abc123", date: "2026-07-11", departmentId: 1 },
  "document.expiring": { employeeId: "user_abc123", documentType: "passport", daysUntilExpiry: 30 },
  "asset.assigned": { employeeId: "user_abc123", assetType: "laptop", assetId: 42 },
  "asset.return_due": { employeeId: "user_abc123", assetType: "laptop", daysUntilDue: 7 },
  "review.cycle_started": { cycleId: 5, cycleName: "Q3 2026 Review", departmentId: 1 },
  "review.due": { cycleId: 5, cycleName: "Q3 2026 Review", deadline: "2026-08-01" },
  "goal.overdue": { employeeId: "user_abc123", goalId: 12, daysPastDue: 3 },
  "course.assigned": { employeeId: "user_abc123", courseId: 7, courseName: "Security Awareness" },
  "resignation.submitted": { employeeId: "user_abc123", lastWorkingDate: "2026-08-11", departmentId: 1, noticePeriodDays: 30 },
  "exit.completed": { employeeId: "user_abc123", exitType: "resignation", departmentId: 1, tenure: 24 },
  "employee.updated": { employeeId: "user_abc123", changedFields: "phone,address", departmentId: 1 },
  "employee.exited": { employeeId: "user_abc123", exitType: "resignation", lastWorkingDate: "2026-08-11", departmentId: 1 },
  "contract.ended": { employeeId: "user_abc123", contractId: 7, contractType: "contractor" },
  "attendance.finalized": { employeeId: "user_abc123", periodMonth: "2026-07", totalDays: 31, presentDays: 22 },
  "payroll.inputs_locked": { periodMonth: "2026-07", lockedBy: "user_abc123", employeeCount: 150 },
};
