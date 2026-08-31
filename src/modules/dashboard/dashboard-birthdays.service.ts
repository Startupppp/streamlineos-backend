import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import {
  hrEmployments,
  hrPeople,
  organizationMembers,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import { AccessService } from "../access/access.service";
import { buildOrgDashboardCacheKey } from "./dashboard-cache-key";
import {
  livePersonOfUser,
  primaryEmploymentOfPerson,
} from "../directory/employment-query";

export interface BirthdayEntry {
  id: string;
  name: string | null;
  designation: string | null;
  image: string | null;
  type: "birthday" | "anniversary";
  date: string;
  yearsCompleted?: number;
}

@Injectable()
export class DashboardBirthdaysService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly access: AccessService,
  ) {}

  async getBirthdays(orgId: string): Promise<BirthdayEntry[]> {
    const today = new Date().toISOString().slice(0, 10);
    const key = await buildOrgDashboardCacheKey(
      this.access,
      orgId,
      "birthdays",
      today,
    );
    return this.cache.cachedForOrg(
      orgId,
      key,
      () => this.buildBirthdays(orgId),
      CACHE_TTL.MEDIUM,
    );
  }

  private async buildBirthdays(orgId: string): Promise<BirthdayEntry[]> {
    const todayDate = new Date();
    const windowDates = Array.from({ length: 8 }, (_, i) => {
      const d = new Date(todayDate);
      d.setDate(todayDate.getDate() + i);
      return {
        str: d.toISOString().split("T")[0],
        mmdd: `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
      };
    });
    const mmddList = windowDates.map((w) => w.mmdd);
    const mmddByDate = new Map(windowDates.map((w) => [w.mmdd, w.str]));

    const mmddValues = sql.join(
      mmddList.map((d) => sql`${d}`),
      sql`, `,
    );

    const [bdayMembers, annivMembers] = await Promise.all([
      this.db
        .select({
          id: users.id,
          name: users.name,
          designation: hrEmployments.designation,
          image: users.image,
          mmdd: sql<string>`to_char(${users.dateOfBirth}::date, 'MM-DD')`,
        })
        .from(users)
        .innerJoin(
          organizationMembers,
          eq(organizationMembers.userId, users.id),
        )
        .leftJoin(hrPeople, livePersonOfUser(orgId, users.id))
        .leftJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(users.isActive, true),
            sql`to_char(${users.dateOfBirth}::date, 'MM-DD') IN (${mmddValues})`,
          ),
        )
        .limit(50),

      this.db
        .select({
          id: users.id,
          name: users.name,
          designation: hrEmployments.designation,
          image: users.image,
          joiningDate: hrEmployments.joiningDate,
          mmdd: sql<string>`to_char(${hrEmployments.joiningDate}::date, 'MM-DD')`,
        })
        .from(users)
        .innerJoin(
          organizationMembers,
          eq(organizationMembers.userId, users.id),
        )
        .leftJoin(hrPeople, livePersonOfUser(orgId, users.id))
        .leftJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(users.isActive, true),
            sql`to_char(${hrEmployments.joiningDate}::date, 'MM-DD') IN (${mmddValues})`,
            sql`EXTRACT(YEAR FROM age(${hrEmployments.joiningDate}::date)) >= 1`,
          ),
        )
        .limit(50),
    ]);

    const result: BirthdayEntry[] = [];
    const seen = new Set<string>();

    for (const m of bdayMembers) {
      const key = `${m.id}-birthday`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        id: m.id,
        name: m.name,
        designation: m.designation,
        image: m.image,
        type: "birthday",
        date:
          mmddByDate.get(m.mmdd) ?? todayDate.toISOString().split("T")[0],
      });
    }

    for (const m of annivMembers) {
      const key = `${m.id}-anniversary`;
      if (seen.has(key)) continue;
      seen.add(key);
      const dateStr =
        mmddByDate.get(m.mmdd) ?? todayDate.toISOString().split("T")[0];
      const years = m.joiningDate
        ? new Date(dateStr).getFullYear() -
          new Date(m.joiningDate).getFullYear()
        : 0;
      result.push({
        id: m.id,
        name: m.name,
        designation: m.designation,
        image: m.image,
        type: "anniversary",
        date: dateStr,
        yearsCompleted: years,
      });
    }

    return result.slice(0, 20);
  }
}
