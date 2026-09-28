import { sql, type SQL } from "drizzle-orm";
import { kbPages } from "../../../db/schema";

export function isVerifiedNow(): SQL {
  return sql`(${kbPages.trustState} = 'verified' AND (${kbPages.verifiedUntil} IS NULL OR ${kbPages.verifiedUntil} >= now()))`;
}

export function hasReviewCommitment(): SQL {
  return sql`(${kbPages.nextReviewAt} IS NOT NULL OR ${kbPages.reviewIntervalDays} IS NOT NULL OR ${kbPages.verifiedUntil} IS NOT NULL)`;
}

export function isReviewDue(): SQL {
  return sql`(${kbPages.nextReviewAt} <= now() OR (NOT ${isVerifiedNow()} AND ${hasReviewCommitment()}))`;
}

export function effectiveTrustState(): SQL<"unverified" | "verified" | "verification_expired"> {
  return sql<"unverified" | "verified" | "verification_expired">`CASE WHEN ${kbPages.trustState} = 'verified' AND ${kbPages.verifiedUntil} IS NOT NULL AND ${kbPages.verifiedUntil} < now() THEN 'verification_expired' ELSE ${kbPages.trustState} END`;
}
