import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  leaveBalances,
  leaveRequests,
  leaveTypes,
  organizationMembers,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";

const CASUAL_LEAVE_NAME = "Casual Leave";
const SICK_LEAVE_NAME = "Sick Leave";
const UNPAID_LEAVE_NAME = "Unpaid Leave";
const CASUAL_DAYS_PER_YEAR = 12;
const SICK_DAYS_PER_YEAR = 6;
const ROLE_CEO = "CEO";
const ROLE_HR = "HR";

const ALLOWED_LEAVE_TYPE_NAMES: ReadonlySet<string> = new Set([
  CASUAL_LEAVE_NAME,
  SICK_LEAVE_NAME,
  UNPAID_LEAVE_NAME,
]);

const DEFAULT_LEAVE_TYPES = [
  { name: CASUAL_LEAVE_NAME, daysPerYear: CASUAL_DAYS_PER_YEAR, carryForward: false },
  { name: SICK_LEAVE_NAME, daysPerYear: SICK_DAYS_PER_YEAR, carryForward: false },
  { name: UNPAID_LEAVE_NAME, daysPerYear: 0, carryForward: false },
] as const;

function calculateProratedCasualLeaves(joiningDate: Date, year: number): number {
  const joinYear = joiningDate.getFullYear();
  if (joinYear > year) return 0;
  if (joinYear < year) return CASUAL_DAYS_PER_YEAR;
  return CASUAL_DAYS_PER_YEAR - joiningDate.getMonth();
}

function resolveInitialBalance(
  typeName: string,
  daysPerYear: number,
  joiningDate: Date,
  year: number,
): number {
  switch (typeName) {
    case CASUAL_LEAVE_NAME:
      return calculateProratedCasualLeaves(joiningDate, year);
    case SICK_LEAVE_NAME:
      return SICK_DAYS_PER_YEAR;
    case UNPAID_LEAVE_NAME:
      return 0;
    default:
      return daysPerYear;
  }
}

@Injectable()
export class LeavesPageService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async pageData(orgId: string, userId: string) {
    const seededTypes = await this.ensureLeaveTypes(orgId);
    const allowedSeeded = seededTypes
      .filter((t) => ALLOWED_LEAVE_TYPE_NAMES.has(t.name))
      .map((t) => ({ id: t.id, name: t.name, daysPerYear: t.daysPerYear }));
    await this.ensureUserBalances(orgId, userId, allowedSeeded);

    const year = new Date().getFullYear();

    const [rawBalances, allTypes, requests, user, member] = await Promise.all([
      this.db
        .select({
          id: leaveBalances.id,
          leaveTypeId: leaveBalances.leaveTypeId,
          balance: leaveBalances.balance,
          typeName: leaveTypes.name,
          daysPerYear: leaveTypes.daysPerYear,
        })
        .from(leaveBalances)
        .leftJoin(leaveTypes, eq(leaveBalances.leaveTypeId, leaveTypes.id))
        .where(
          and(
            eq(leaveBalances.userId, userId),
            eq(leaveBalances.orgId, orgId),
            eq(leaveBalances.year, year),
          ),
        ),
      this.db.query.leaveTypes.findMany({ where: eq(leaveTypes.orgId, orgId) }),
      this.db.query.leaveRequests.findMany({
        where: and(eq(leaveRequests.userId, userId), eq(leaveRequests.orgId, orgId)),
        with: {
          leaveType: { columns: { id: true, name: true, daysPerYear: true } },
          approver: { columns: { id: true, name: true, firstName: true, lastName: true } },
        },
        orderBy: [desc(leaveRequests.createdAt)],
      }),
      this.db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { joiningDate: true },
      }),
      this.db.query.organizationMembers.findFirst({
        where: and(eq(organizationMembers.userId, userId), eq(organizationMembers.orgId, orgId)),
        columns: { role: true },
      }),
    ]);

    const seenNames = new Set<string>();
    const balances = rawBalances.filter((b) => {
      if (!b.typeName || !ALLOWED_LEAVE_TYPE_NAMES.has(b.typeName) || seenNames.has(b.typeName)) {
        return false;
      }
      seenNames.add(b.typeName);
      return true;
    });

    const seenTypeNames = new Set<string>();
    const types = allTypes.filter((t) => {
      if (seenTypeNames.has(t.name)) return false;
      seenTypeNames.add(t.name);
      return true;
    });

    const approvers = await this.resolveApprovers(orgId, userId, member?.role ?? null);

    return {
      balances,
      types,
      requests,
      joiningDate: user?.joiningDate ?? null,
      approvers,
    };
  }

  private async ensureLeaveTypes(orgId: string) {
    const existing = await this.db.query.leaveTypes.findMany({
      where: eq(leaveTypes.orgId, orgId),
    });
    const existingNames = new Set(existing.map((t) => t.name));
    const missing = DEFAULT_LEAVE_TYPES.filter((t) => !existingNames.has(t.name));

    if (missing.length === 0) return existing;

    await this.db
      .insert(leaveTypes)
      .values(
        missing.map((t) => ({
          orgId,
          name: t.name,
          daysPerYear: t.daysPerYear,
          carryForward: t.carryForward,
        })),
      )
      .onConflictDoNothing();

    return this.db.query.leaveTypes.findMany({ where: eq(leaveTypes.orgId, orgId) });
  }

  private async ensureUserBalances(
    orgId: string,
    userId: string,
    types: { id: number; name: string; daysPerYear: number }[],
  ) {
    if (types.length === 0) return;

    const year = new Date().getFullYear();
    const [existing, user] = await Promise.all([
      this.db.query.leaveBalances.findMany({
        where: and(
          eq(leaveBalances.userId, userId),
          eq(leaveBalances.orgId, orgId),
          eq(leaveBalances.year, year),
        ),
        columns: { leaveTypeId: true },
      }),
      this.db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { joiningDate: true },
      }),
    ]);

    const existingTypeIds = new Set(existing.map((b) => b.leaveTypeId));
    const joiningDate = user?.joiningDate ? new Date(user.joiningDate) : new Date();

    const toInsert = types
      .filter((t) => !existingTypeIds.has(t.id))
      .map((t) => ({
        orgId,
        userId,
        leaveTypeId: t.id,
        year,
        balance: resolveInitialBalance(t.name, t.daysPerYear, joiningDate, year).toString(),
      }));

    if (toInsert.length === 0) return;

    await this.db.insert(leaveBalances).values(toInsert).onConflictDoNothing();
  }

  private async resolveApprovers(orgId: string, userId: string, role: string | null) {
    if (!role) return [];

    const targetRoles =
      role === ROLE_CEO
        ? [ROLE_HR]
        : role === ROLE_HR
          ? [ROLE_CEO]
          : [ROLE_HR, ROLE_CEO];

    const approverMembers = await this.db.query.organizationMembers.findMany({
      where: and(
        eq(organizationMembers.orgId, orgId),
        inArray(organizationMembers.role, targetRoles),
      ),
      with: {
        user: {
          columns: {
            id: true,
            name: true,
            firstName: true,
            lastName: true,
            email: true,
            image: true,
            designation: true,
          },
        },
      },
    });

    return approverMembers
      .filter((m) => m.userId !== userId)
      .map((m) => m.user)
      .filter((user): user is NonNullable<typeof user> => user !== null);
  }
}
