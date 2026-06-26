export const LEAVE_POLICY = {
  CASUAL: {
    name: "Casual Leave",
    daysPerYear: 12,
    perMonth: 1,
    carryForward: false,
  },
  SICK: {
    name: "Sick Leave",
    daysPerYear: 6,
    carryForward: false,
  },
  UNPAID: {
    name: "Unpaid Leave",
    daysPerYear: 0,
    carryForward: false,
  },
} as const;

export const DEFAULT_LEAVE_TYPES = [
  { name: LEAVE_POLICY.CASUAL.name, daysPerYear: LEAVE_POLICY.CASUAL.daysPerYear, carryForward: LEAVE_POLICY.CASUAL.carryForward },
  { name: LEAVE_POLICY.SICK.name, daysPerYear: LEAVE_POLICY.SICK.daysPerYear, carryForward: LEAVE_POLICY.SICK.carryForward },
  { name: LEAVE_POLICY.UNPAID.name, daysPerYear: LEAVE_POLICY.UNPAID.daysPerYear, carryForward: LEAVE_POLICY.UNPAID.carryForward },
] as const;

export function calculateProratedCasualLeaves(joiningDate: Date, year: number): number {
  const joinYear = joiningDate.getFullYear();
  if (joinYear > year) return 0;
  if (joinYear < year) return LEAVE_POLICY.CASUAL.daysPerYear;
  return LEAVE_POLICY.CASUAL.daysPerYear - joiningDate.getMonth();
}

export function resolveInitialBalance(
  typeName: string,
  daysPerYear: number,
  joiningDate: Date,
  year: number,
): number {
  switch (typeName) {
    case LEAVE_POLICY.CASUAL.name:
      return calculateProratedCasualLeaves(joiningDate, year);
    case LEAVE_POLICY.SICK.name:
      return LEAVE_POLICY.SICK.daysPerYear;
    case LEAVE_POLICY.UNPAID.name:
      return 0;
    default:
      return daysPerYear;
  }
}
