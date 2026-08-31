export type EnsurePersonEmploymentInput = {
  userId: string;
  firstName: string;
  lastName: string;
  workEmail: string;
  employeeNumber: string;
  joiningDate?: string | null;
  designation?: string | null;
  phone?: string | null;
  lifecycleStatus?:
    | "PRE_JOINING"
    | "ONBOARDING"
    | "ACTIVE"
    | "PROBATION"
    | "CONFIRMED";
  workerType?:
    | "FULL_TIME"
    | "PART_TIME"
    | "CONTRACTOR"
    | "CONSULTANT"
    | "INTERN"
    | "TEMPORARY"
    | "AGENCY"
    | "FREELANCER";
};

export type EnsurePersonEmploymentResult = {
  personId: number;
  employmentId: number;
  createdPerson: boolean;
  createdEmployment: boolean;
};

export type PrefetchedActiveMember = {
  membershipId: number;
  userId: string;
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  email: string;
  phone: string | null;
};

export type BackfillResult = {
  scanned: number;
  createdPeople: number;
  createdEmployments: number;
  skipped: number;
  errors: Array<{ userId: string; message: string }>;
};

export function toEnsureInput(
  user: Omit<PrefetchedActiveMember, "membershipId">,
  lifecycleStatus: EnsurePersonEmploymentInput["lifecycleStatus"],
): EnsurePersonEmploymentInput {
  const firstName = user.firstName?.trim() || user.name?.split(" ")[0] || "Employee";
  const lastName =
    user.lastName?.trim() ||
    user.name?.split(" ").slice(1).join(" ") ||
    "User";
  const employeeNumber = `EMP-${user.userId.slice(0, 8).toUpperCase()}`;

  return {
    userId: user.userId,
    firstName,
    lastName,
    workEmail: user.email,
    employeeNumber,
    joiningDate: null,
    designation: null,
    phone: user.phone ?? null,
    lifecycleStatus,
  };
}
