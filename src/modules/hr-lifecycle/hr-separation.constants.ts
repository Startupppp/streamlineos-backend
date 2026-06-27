export const TERMINATION_REASONS = [
  "Performance Issues",
  "Attendance Issues",
  "Policy Violations",
  "Misconduct",
  "Behavioral Concerns",
  "Violation of Company Policies",
  "Unauthorized Absence",
  "Poor Productivity",
  "Project Non-Compliance",
  "Organizational Restructuring",
  "Position Redundancy",
  "End of Contract",
  "Security or Compliance Breach",
  "Other",
] as const;

export const TERMINATION_REASON_OTHER = "Other";

export type TerminationReason = (typeof TERMINATION_REASONS)[number];

export const RESIGNATION_REASONS = [
  "Career growth opportunities",
  "Higher education or further studies",
  "Better salary or benefits",
  "Relocation (family/personal reasons)",
  "Work-life balance issues",
  "Change in career path",
  "Health reasons",
  "Personal commitments",
  "Job dissatisfaction",
  "Starting own business",
  "Other",
] as const;

export const RESIGNATION_REASON_OTHER = "Other";

export type ResignationReason = (typeof RESIGNATION_REASONS)[number];
