import { eq, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { feedbucketSubmissions } from "../../db/schema";
import type { OwnershipScope } from "../access/scoped-read";

export function feedbucketScope(userId: string, membershipId: number | null): OwnershipScope {
  const teamOwnerColumn: PgColumn = feedbucketSubmissions.assigneeMembershipId;
  return {
    own: membershipId !== null ? eq(feedbucketSubmissions.assigneeMembershipId, membershipId) : sql`false`,
    team: membershipId !== null ? eq(teamOwnerColumn, membershipId) : sql`false`,
  };
}
