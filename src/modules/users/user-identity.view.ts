export const EMPLOYMENT_FIELDS_DROPPED_IN_V2 = [
  "designation",
  "departmentId",
  "branchId",
  "reportingTo",
] as const;

export type EmploymentFieldDroppedInV2 =
  (typeof EMPLOYMENT_FIELDS_DROPPED_IN_V2)[number];

type WithEmploymentFields = Partial<Record<EmploymentFieldDroppedInV2, unknown>>;

export function toUserIdentity<T extends WithEmploymentFields>(
  user: T,
): Omit<T, EmploymentFieldDroppedInV2> {
  const { designation, departmentId, branchId, reportingTo, ...identity } = user;
  return identity;
}

export function toUserIdentityPage<T extends WithEmploymentFields>(page: {
  data: T[];
  pagination: unknown;
}): { data: Omit<T, EmploymentFieldDroppedInV2>[]; pagination: unknown } {
  return { data: page.data.map(toUserIdentity), pagination: page.pagination };
}
