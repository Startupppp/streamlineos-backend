import { eq, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { feedbucketSubmissions } from "../../db/schema";
import type { OwnershipScope } from "../access/scoped-read";

/** `team` compares the membership column to the actor's USER id, a pre-existing mismatch inherited from the DataScope-era fallback; preserved as-is. */
export function feedbucketScope(userId: string, membershipId: number | null): OwnershipScope {
  const teamOwnerColumn: PgColumn = feedbucketSubmissions.assigneeMembershipId;
  return {
    own: membershipId !== null ? eq(feedbucketSubmissions.assigneeMembershipId, membershipId) : sql`false`,
    team: eq(teamOwnerColumn, userId),
  };
}
