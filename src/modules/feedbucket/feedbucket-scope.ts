import type { DataScope } from "../access/access.types";
import { eq, type SQL } from "drizzle-orm";
import { feedbucketSubmissions } from "../../db/schema";
import { applyScope } from "../access/apply-scope";

export function applyFeedbucketScope(
  scope: DataScope,
  orgId: string,
  userId: string,
  membershipId: number | null,
): SQL {
  if (scope === "own")
    return membershipId !== null
      ? eq(feedbucketSubmissions.assigneeMembershipId, membershipId)
      : eq(feedbucketSubmissions.assigneeId, userId);
  return applyScope(scope, orgId, userId, { ownerColumn: feedbucketSubmissions.assigneeId });
}
