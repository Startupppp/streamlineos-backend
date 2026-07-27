import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { leaveRequests, leaveTypes, organizationMembers, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import { addYears, differenceInDays, formatDateOnly, formatMonthDay, startOfDay } from "../../common/date";

export interface FeedItem {
  userId: string;
  name: string | null;
  image: string | null;
  type: "BIRTHDAY" | "WORK_ANNIVERSARY";
  daysAway: number;
  dateStr: string;
  yearsCount?: number;
}

export type AvailabilityStatus = "ON_LEAVE" | "HALF_DAY" | "AVAILABLE";

export interface AvailabilityEntry {
  userId: string;
  status: AvailabilityStatus;
  leaveType?: string;
}

@Injectable()
export class CelebrationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  getAnniversaryFeed(orgId: string): Promise<FeedItem[]> {
    const today = new Date().toISOString().slice(0, 10);
    return this.cache.cached(`hr:anniversary-feed:${orgId}:${today}`, () => this.buildAnniversaryFeed(orgId), CACHE_TTL.MEDIUM);
  }

  private async buildAnniversaryFeed(orgId: string): Promise<FeedItem[]> {
    const members = await this.db
      .select({
        userId: organizationMembers.userId,
        name: users.name,
        image: users.image,
        dateOfBirth: users.dateOfBirth,
        joiningDate: users.joiningDate,
      })
      .from(organizationMembers)
      .leftJoin(users, eq(users.id, organizationMembers.userId))
      .where(eq(organizationMembers.orgId, orgId))
      .limit(1000);

    const today = startOfDay(new Date());
    const items: FeedItem[] = [];

    for (const m of members) {
      if (!m.name) continue;

      if (m.dateOfBirth) {
        const dob = new Date(m.dateOfBirth);
        let nextBirthday = new Date(today.getFullYear(), dob.getMonth(), dob.getDate());
        if (nextBirthday < today) nextBirthday = addYears(nextBirthday, 1);
        const days = differenceInDays(nextBirthday, today);
        if (days <= 30) {
          items.push({
            userId: m.userId,
            name: m.name,
            image: m.image,
            type: "BIRTHDAY",
            daysAway: days,
            dateStr: formatMonthDay(nextBirthday),
          });
        }
      }

      if (m.joiningDate) {
        const joined = new Date(m.joiningDate);
        const yearsCompleted = today.getFullYear() - joined.getFullYear();
        if (yearsCompleted >= 1) {
          let nextAnniversary = new Date(today.getFullYear(), joined.getMonth(), joined.getDate());
          if (nextAnniversary < today) nextAnniversary = addYears(nextAnniversary, 1);
          const days = differenceInDays(nextAnniversary, today);
          if (days <= 30) {
            const years = nextAnniversary.getFullYear() - joined.getFullYear();
            items.push({
              userId: m.userId,
              name: m.name,
              image: m.image,
              type: "WORK_ANNIVERSARY",
              daysAway: days,
              dateStr: formatMonthDay(nextAnniversary),
              yearsCount: years,
            });
          }
        }
      }
    }

    items.sort((a, b) => a.daysAway - b.daysAway);
    return items;
  }

  getCelebrations(orgId: string) {
    const today = new Date().toISOString().slice(0, 10);
    return this.cache.cached(`hr:celebrations:${orgId}:${today}`, () => this.buildCelebrations(orgId), CACHE_TTL.MEDIUM);
  }

  private async buildCelebrations(orgId: string) {
    const now = new Date();
    const month = now.getMonth() + 1;
    const day = now.getDate();

    const members = await this.db
      .select({
        id: users.id,
        name: users.name,
        firstName: users.firstName,
        lastName: users.lastName,
        image: users.image,
        dateOfBirth: users.dateOfBirth,
        joiningDate: users.joiningDate,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true)))
      .limit(1000);

    const birthdays: typeof members = [];
    const anniversaries: Array<(typeof members)[number] & { years: number }> = [];
    const upcomingBirthdays: typeof members = [];

    for (const m of members) {
      if (m.dateOfBirth) {
        const dob = new Date(m.dateOfBirth);
        const dobMonth = dob.getMonth() + 1;
        const dobDay = dob.getDate();
        if (dobMonth === month && dobDay === day) {
          birthdays.push(m);
        } else if (dobMonth === month && dobDay > day && dobDay <= day + 7) {
          upcomingBirthdays.push(m);
        }
      }
      if (m.joiningDate) {
        const jd = new Date(m.joiningDate);
        const jdMonth = jd.getMonth() + 1;
        const jdDay = jd.getDate();
        if (jdMonth === month && jdDay === day) {
          const years = now.getFullYear() - jd.getFullYear();
          if (years > 0) {
            anniversaries.push({ ...m, years });
          }
        }
      }
    }

    return {
      todayBirthdays: birthdays,
      upcomingBirthdays,
      todayAnniversaries: anniversaries,
    };
  }

  async getAvailability(orgId: string, userIds: string | undefined): Promise<AvailabilityEntry[]> {
    const today = formatDateOnly(new Date());

    let userIdList: string[] = [];
    if (userIds) {
      userIdList = userIds
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
    } else {
      const members = await this.db
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(eq(organizationMembers.orgId, orgId));
      userIdList = members.map((m) => m.userId);
    }

    if (userIdList.length === 0) return [];

    const activeLeaves = await this.db
      .select({
        userId: leaveRequests.userId,
        leaveTypeName: leaveTypes.name,
        isHalfDay: leaveRequests.isHalfDay,
      })
      .from(leaveRequests)
      .leftJoin(leaveTypes, eq(leaveRequests.leaveTypeId, leaveTypes.id))
      .where(
        and(
          eq(leaveRequests.orgId, orgId),
          eq(leaveRequests.status, "APPROVED"),
          lte(leaveRequests.startDate, today),
          gte(leaveRequests.endDate, today),
          inArray(leaveRequests.userId, userIdList),
        ),
      );

    const leaveByUser = new Map(activeLeaves.map((l) => [l.userId, l]));

    const result: AvailabilityEntry[] = userIdList.map((userId) => {
      const leave = leaveByUser.get(userId);
      if (!leave) return { userId, status: "AVAILABLE" };
      return {
        userId,
        status: leave.isHalfDay ? "HALF_DAY" : "ON_LEAVE",
        leaveType: leave.leaveTypeName ?? undefined,
      };
    });

    return result;
  }
}
