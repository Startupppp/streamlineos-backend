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
