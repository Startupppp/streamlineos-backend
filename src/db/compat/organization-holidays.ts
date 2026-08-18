import { and, asc, eq, gte, lte } from "drizzle-orm";
import type { Db } from "../drizzle.types";
import { holidays, orgHolidays } from "../schema";

const HOLIDAY_READ_LIMIT = 500;

export type CompatibleHoliday = {
  id: string;
  name: string;
  date: string;
  source: "canonical" | "legacy";
};

function holidayKey(holiday: Pick<CompatibleHoliday, "date" | "name">): string {
  return `${holiday.date}\u0000${holiday.name.trim().toLocaleLowerCase("en")}`;
}

export function mergeCompatibleHolidays(
  canonical: CompatibleHoliday[],
  legacy: CompatibleHoliday[],
): CompatibleHoliday[] {
  const byKey = new Map<string, CompatibleHoliday>();
  for (const holiday of canonical) byKey.set(holidayKey(holiday), holiday);
  for (const holiday of legacy) {
    const key = holidayKey(holiday);
    if (!byKey.has(key)) byKey.set(key, holiday);
  }
  return [...byKey.values()].sort(
    (left, right) =>
      left.date.localeCompare(right.date) ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id),
  );
}

export async function listCompatibleHolidays(
  db: Db,
  orgId: string,
  from: string,
  to: string,
): Promise<CompatibleHoliday[]> {
  const [canonicalRows, legacyRows] = await Promise.all([
    db
      .select({ id: orgHolidays.id, name: orgHolidays.name, date: orgHolidays.date })
      .from(orgHolidays)
      .where(
        and(
          eq(orgHolidays.orgId, orgId),
          gte(orgHolidays.date, from),
          lte(orgHolidays.date, to),
        ),
      )
      .orderBy(asc(orgHolidays.date), asc(orgHolidays.id))
      .limit(HOLIDAY_READ_LIMIT),
    db
      .select({ id: holidays.id, name: holidays.name, date: holidays.date })
      .from(holidays)
      .where(
        and(
          eq(holidays.orgId, orgId),
          gte(holidays.date, from),
          lte(holidays.date, to),
        ),
      )
      .orderBy(asc(holidays.date), asc(holidays.id))
      .limit(HOLIDAY_READ_LIMIT),
  ]);

  return mergeCompatibleHolidays(
    canonicalRows.map((holiday) => ({ ...holiday, source: "canonical" })),
    legacyRows.map((holiday) => ({
      id: `legacy:${holiday.id}`,
      name: holiday.name,
      date: holiday.date,
      source: "legacy",
    })),
  );
}

export async function hasCompatibleHolidays(db: Db, orgId: string): Promise<boolean> {
  const [canonicalRows, legacyRows] = await Promise.all([
    db
      .select({ id: orgHolidays.id })
      .from(orgHolidays)
      .where(eq(orgHolidays.orgId, orgId))
      .limit(1),
    db
      .select({ id: holidays.id })
      .from(holidays)
      .where(eq(holidays.orgId, orgId))
      .limit(1),
  ]);
  return canonicalRows.length > 0 || legacyRows.length > 0;
}
