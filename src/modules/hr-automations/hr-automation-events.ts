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
  "goal.overdue",
  "course.assigned",
  "resignation.submitted",
  "exit.completed",
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
  "goal.overdue": { employeeId: "user_abc123", goalId: 12, daysPastDue: 3 },
  "course.assigned": { employeeId: "user_abc123", courseId: 7, courseName: "Security Awareness" },
  "resignation.submitted": { employeeId: "user_abc123", lastWorkingDate: "2026-08-11", departmentId: 1, noticePeriodDays: 30 },
  "exit.completed": { employeeId: "user_abc123", exitType: "resignation", departmentId: 1, tenure: 24 },
};
