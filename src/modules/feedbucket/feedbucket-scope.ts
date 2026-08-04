import type { DataScope } from "../access/access.types";
import type { SQL } from "drizzle-orm";
import { feedbucketSubmissions } from "../../db/schema";
import { applyScope } from "../access/apply-scope";

export function applyFeedbucketScope(scope: DataScope, orgId: string, userId: string): SQL {
  return applyScope(scope, orgId, userId, {
    ownerColumn: feedbucketSubmissions.assigneeId,
  });
}
