import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  leaveBalances,
  leaveTypes,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { LeaveApproverService } from "./leave-approver.service";

@Injectable()
export class LeavesPageService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly approvers: LeaveApproverService,
  ) {}

  async pageData(orgId: string, userId: string) {
    const year = new Date().getFullYear();

    const balanceQuery = this.db
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

    const [existingBalances, allTypes, user] = await Promise.all([
      balanceQuery,
      this.db.query.leaveTypes.findMany({ where: eq(leaveTypes.orgId, orgId) }),
      this.db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { joiningDate: true },
      }),
    ]);

    const seenTypeIds = new Set<number>();
    const balances = existingBalances.filter((balance) => {
      if (balance.leaveTypeId === null || seenTypeIds.has(balance.leaveTypeId)) return false;
      seenTypeIds.add(balance.leaveTypeId);
      return true;
    });

    const seenTypeNames = new Set<string>();
    const types = allTypes.filter((leaveType) => {
      if (seenTypeNames.has(leaveType.name)) return false;
      seenTypeNames.add(leaveType.name);
      return true;
    });

    const approver = await this.approvers.resolve(orgId, userId);

    return {
      balances,
      types,
      joiningDate: user?.joiningDate ?? null,
      approvers: approver ? [approver] : [],
    };
  }
}
