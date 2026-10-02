import { ForbiddenException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { organizationMembers, organizations, users } from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { isKnownTimeZone } from "../../../../common/date/zoned-wall-clock";

export const FALLBACK_TIMEZONE = "UTC";

export const INACTIVE_MEMBERSHIP_REFUSAL = {
  code: "ORG_MEMBERSHIP_INACTIVE",
  message:
    "Your access to this organization is no longer active. Refresh to continue with an available organization.",
} as const;

export interface AskOsActor {
  userId: string;
  orgId: string;
  membershipId: number;
  displayName: string;
  email: string;
  orgName: string;
  role: string;
  isOrgOwner: boolean;
  timezone: string;
  today: string;
  monthStart: string;
  monthEnd: string;
  currentYear: number;
  currentMonth: number;
}

export function displayNameFrom(row: {
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string;
}): string {
  if (row.name?.trim()) return row.name.trim();
  const composed = `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim();
  if (composed) return composed;
  return row.email;
}

export function usableTimezone(timezone: string | null | undefined): string {
  return timezone && isKnownTimeZone(timezone) ? timezone : FALLBACK_TIMEZONE;
}

export function zonedCalendarFacts(timezone: string, now: Date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: usableTimezone(timezone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const lookup = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  const year = Number(lookup("year"));
  const month = Number(lookup("month"));
  const today = `${lookup("year")}-${lookup("month")}-${lookup("day")}`;
  const monthStart = `${lookup("year")}-${lookup("month")}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthEnd = `${lookup("year")}-${lookup("month")}-${String(lastDay).padStart(2, "0")}`;
  return { today, monthStart, monthEnd, currentYear: year, currentMonth: month };
}

export async function resolveOrgTimezone(db: Db, orgId: string): Promise<string> {
  const rows = await db
    .select({ timezone: organizations.timezone })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return usableTimezone(rows[0]?.timezone);
}

export async function resolveAskOsActor(
  db: Db,
  caller: CurrentUserContext,
  now: Date = new Date(),
): Promise<AskOsActor> {
  const rows = await db
    .select({
      name: users.name,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
      role: organizationMembers.role,
      isOwner: organizationMembers.isOwner,
      membershipId: organizationMembers.id,
      orgName: organizations.name,
      timezone: organizations.timezone,
    })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
    .where(
      and(
        eq(organizationMembers.orgId, caller.orgId),
        eq(organizationMembers.userId, caller.userId),
        eq(organizationMembers.status, "ACTIVE"),
        eq(users.isActive, true),
        isNull(users.deletedAt),
        eq(organizations.status, "ACTIVE"),
        isNull(organizations.deletedAt),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) throw new ForbiddenException(INACTIVE_MEMBERSHIP_REFUSAL);

  const timezone = usableTimezone(row.timezone);
  const calendar = zonedCalendarFacts(timezone, now);

  return {
    userId: caller.userId,
    orgId: caller.orgId,
    membershipId: row.membershipId,
    displayName: displayNameFrom(row),
    email: row.email,
    orgName: row.orgName,
    role: row.role,
    isOrgOwner: row.isOwner,
    timezone,
    ...calendar,
  };
}
