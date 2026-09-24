import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, inArray, isNull, type SQL } from "drizzle-orm";
import { projectApprovals } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";

export function pendingApprovalsForActorCondition(
  orgId: string,
  membershipId: number,
): SQL | undefined {
  return and(
    eq(projectApprovals.orgId, orgId),
    eq(projectApprovals.approverMembershipId, membershipId),
    inArray(projectApprovals.status, ["pending", "escalated"]),
    isNull(projectApprovals.deletedAt),
  );
}

@Injectable()
export class BuildInboxCountService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async countPending(orgId: string, membershipId: number | null): Promise<number> {
    if (membershipId === null) return 0;
    const [row] = await this.db
      .select({ total: count() })
      .from(projectApprovals)
      .where(pendingApprovalsForActorCondition(orgId, membershipId));
    return row?.total ?? 0;
  }
}
