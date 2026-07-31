import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import {
  leaveBalances,
  leaveRequests,
  leaveTypes,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AccessService } from "../../access/access.service";

@Injectable()
export class LeavesPageService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  async pageData(orgId: string, userId: string) {
    const year = new Date().getFullYear();

    const balanceQuery = () =>
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
        );

    const [existingBalances, allTypes, requests, user] = await Promise.all([
      balanceQuery(),
      this.db.query.leaveTypes.findMany({ where: eq(leaveTypes.orgId, orgId) }),
      this.db.query.leaveRequests.findMany({
        where: and(eq(leaveRequests.userId, userId), eq(leaveRequests.orgId, orgId)),
        with: {
          leaveType: { columns: { id: true, name: true, daysPerYear: true } },
          approver: { columns: { id: true, name: true, firstName: true, lastName: true } },
        },
        orderBy: [desc(leaveRequests.createdAt)],
        limit: 200,
      }),
      this.db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { joiningDate: true },
      }),
    ]);

    const existingTypeIds = new Set(existingBalances.map((b) => b.leaveTypeId));
    const joiningDate = user?.joiningDate ? new Date(user.joiningDate) : new Date();
    const toInsert = allTypes
      .filter((t) => !existingTypeIds.has(t.id))
      .map((t) => ({
        orgId,
        userId,
        leaveTypeId: t.id,
        year,
        balance: this.calculateInitialBalance(t.daysPerYear, joiningDate, year).toString(),
      }));

    let rawBalances = existingBalances;
    if (toInsert.length > 0) {
      await this.db.insert(leaveBalances).values(toInsert).onConflictDoNothing();
      rawBalances = await balanceQuery();
    }

    const seenTypeIds = new Set<number>();
    const balances = rawBalances.filter((b) => {
      if (b.leaveTypeId === null || seenTypeIds.has(b.leaveTypeId)) return false;
      seenTypeIds.add(b.leaveTypeId);
      return true;
    });

    const seenTypeNames = new Set<string>();
    const types = allTypes.filter((t) => {
      if (seenTypeNames.has(t.name)) return false;
      seenTypeNames.add(t.name);
      return true;
    });

    const approvers = await this.resolveApprovers(orgId, userId);

    return {
      balances,
      types,
      requests,
      joiningDate: user?.joiningDate ?? null,
      approvers,
    };
  }

  private calculateInitialBalance(daysPerYear: number, joiningDate: Date, year: number): number {
    if (daysPerYear === 0) return 0;
    const joinYear = joiningDate.getFullYear();
    if (joinYear > year) return 0;
    if (joinYear < year) return daysPerYear;
    const monthsRemaining = 12 - joiningDate.getMonth();
    return Math.round((daysPerYear / 12) * monthsRemaining * 10) / 10;
  }

  private async resolveApprovers(orgId: string, userId: string) {
    const approvers = await this.access.membersWithPermission(orgId, "hr:leaves:approve");
    const otherApprovers = approvers.filter((m) => m.userId !== userId);
    if (otherApprovers.length === 0) return [];

    const userRows = await this.db.query.users.findMany({
      where: (u, { inArray: inArr }) => inArr(u.id, otherApprovers.map((m) => m.userId)),
      columns: { id: true, name: true, firstName: true, lastName: true, email: true, image: true, designation: true },
    });

    return userRows;
  }
}
