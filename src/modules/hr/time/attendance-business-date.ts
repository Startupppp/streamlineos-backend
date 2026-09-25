import { eq } from "drizzle-orm";
import { formatInTimeZone } from "date-fns-tz";
import { organizations } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { getTodayString } from "../../../common/date";

/**
 * Today's date in the organization's timezone — the same business date
 * check-in stamps on `attendance.date`. Reads that key on the server's local
 * date miss every row written after the org's midnight but before the
 * server's (or vice versa), so a checked-in user reads as "Not checked in".
 * Falls back to the server date only when the org has no valid timezone, in
 * which case check-in refuses anyway and there is nothing to disagree with.
 */
export async function orgBusinessDate(db: Db, orgId: string): Promise<string> {
  const [organization] = await db
    .select({ timezone: organizations.timezone })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!organization?.timezone) return getTodayString();
  try {
    return formatInTimeZone(new Date(), organization.timezone, "yyyy-MM-dd");
  } catch {
    return getTodayString();
  }
}
