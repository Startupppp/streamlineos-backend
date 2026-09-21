import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  leaveBalances,
  leaveTypes,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { ApprovalAuthorityService } from "../../directory/approval-authority.service";
import { EmploymentFactsService } from "../../directory/employment-facts.service";
import { requireOrganizationMembershipId } from "./organization-membership";

@Injectable()
export class LeavesPageService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly approvals: ApprovalAuthorityService,
    private readonly employment: EmploymentFactsService,
  ) {}

  async pageData(orgId: string, userId: string) {
    const year = new Date().getFullYear();
    const userMembershipId = await requireOrganizationMembershipId(this.db, orgId, userId);

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
          eq(leaveBalances.userMembershipId, userMembershipId),
          eq(leaveBalances.orgId, orgId),
          eq(leaveBalances.year, year),
        ),
      )
      .limit(100);

    const [existingBalances, allTypes, facts] = await Promise.all([
      balanceQuery,
      this.db.query.leaveTypes.findMany({ limit: 100, where: eq(leaveTypes.orgId, orgId) }),
      this.employment.getFacts(orgId, userId),
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

    const approvalRoute = await this.approvals.resolve(orgId, userId, "leave");
    const approvers = approvalRoute.approver ? [approvalRoute.approver] : approvalRoute.queue?.members ?? [];

    return {
      balances,
      types,
      joiningDate: facts.joiningDate,
      approvers: approvers.map((candidate) => ({ id: candidate.userId, name: candidate.name, email: candidate.email })),
      approvalRoute,
    };
  }
}
