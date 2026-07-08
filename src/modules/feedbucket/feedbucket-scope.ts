import type { DataScope } from "../access/access.types";
import type { SQL } from "drizzle-orm";
import { eq, sql } from "drizzle-orm";
import { feedbucketSubmissions } from "../../db/schema";

export function applyFeedbucketScope(scope: DataScope, userId: string): SQL | undefined {
  if (scope === "own") return eq(feedbucketSubmissions.assigneeId, userId);
  if (scope === "none") return sql`1 = 0`;
  return undefined;
}
