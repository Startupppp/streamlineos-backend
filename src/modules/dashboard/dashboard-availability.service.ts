import { Inject, Injectable } from "@nestjs/common";
import { asc, countDistinct, desc, eq, sql } from "drizzle-orm";
import {
  attendance,
  hrEmployments,
  hrPeople,
  organizationMembers,
  organizations,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AccessService } from "../access/access.service";
import type { ScopedRead } from "../access/scoped-read";
import { formatInTimeZone } from "date-fns-tz";
import { getTodayString } from "../../common/date";
import { resolveAttendanceReadScope } from "../hr/time/attendance-scope";
import { buildScopedSectionCacheKey } from "./dashboard-cache-key";
import {
  livePersonOfUser,
  primaryEmploymentOfPerson,
} from "../directory/employment-query";
import { DASHBOARD_ATTENDANCE_ROW_CAP } from "./dashboard-read-limits";

@Injectable()
export class DashboardAvailabilityService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly access: AccessService,
  ) {}

  async getTeamAvailability(u: CurrentUserContext) {
    const { orgId } = u;
    const read = await resolveAttendanceReadScope(this.access, u);
    if (read.denied) return [];
    const org = await this.db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
      columns: { timezone: true },
    });
    const orgTz = org?.timezone ?? "UTC";
    const today = formatInTimeZone(new Date(), orgTz, "yyyy-MM-dd");
    const key = await buildScopedSectionCacheKey(
      this.access,
      u,
      "team-availability",
      read,
      `${orgTz}:${today}`,
    );
    return this.cache.cachedForOrg(
      orgId,
      key,
      () =>
        read.read(
          {
            tenant: attendance.orgId,
            scope: { columns: { ownerColumn: attendance.userId } },
            and: [eq(attendance.date, today)],
          },
          async ({ sql: where }) => {
            const todayAttendance = await this.db
              .select({
                userId: attendance.userId,
                checkIn: attendance.checkIn,
                checkOut: attendance.checkOut,
                createdAt: attendance.createdAt,
                userName: users.name,
                firstName: users.firstName,
                lastName: users.lastName,
                userImage: users.image,
              })
              .from(attendance)
              .innerJoin(users, eq(attendance.userId, users.id))
              .where(where)
              .orderBy(asc(attendance.userId), desc(attendance.createdAt))
              .limit(DASHBOARD_ATTENDANCE_ROW_CAP);

            const byUser = new Map<string, (typeof todayAttendance)[number]>();
            for (const record of todayAttendance) {
              const existing = byUser.get(record.userId);
              if (!existing) {
                byUser.set(record.userId, record);
                continue;
              }
              const recordOpen = Boolean(record.checkIn) && !record.checkOut;
              const existingOpen = Boolean(existing.checkIn) && !existing.checkOut;
              if (recordOpen && !existingOpen) {
                byUser.set(record.userId, record);
                continue;
              }
              if (recordOpen === existingOpen) {
                const recordCreated = record.createdAt
                  ? new Date(record.createdAt).getTime()
                  : 0;
                const existingCreated = existing.createdAt
                  ? new Date(existing.createdAt).getTime()
                  : 0;
                if (recordCreated > existingCreated)
                  byUser.set(record.userId, record);
              }
            }

            return [...byUser.values()].map((record) => ({
              userId: record.userId,
              name:
                record.firstName && record.lastName
                  ? `${record.firstName} ${record.lastName}`
                  : record.userName || "Unknown",
              image: record.userImage,
              checkIn: record.checkIn,
              checkOut: record.checkOut,
              isOnline: Boolean(record.checkIn) && !record.checkOut,
            }));
          },
          () => [],
        ),
      CACHE_TTL.SHORT,
    );
  }

  async getTeamAttendance(u: CurrentUserContext) {
    const { orgId } = u;
    const read = await resolveAttendanceReadScope(this.access, u);
    if (read.denied)
      return {
        total: 0,
        present: 0,
        clockedIn: 0,
        absent: 0,
        records: [],
        hasMore: false,
      };
    const today = getTodayString();
    const key = await buildScopedSectionCacheKey(
      this.access,
      u,
      "team-attendance",
      read,
      today,
    );
    return this.cache.cachedForOrg(
      orgId,
      key,
      () => this.buildTeamAttendance(today, read),
      CACHE_TTL.SHORT,
    );
  }

  private async buildTeamAttendance(today: string, read: ScopedRead) {
    const orgId = read.orgId;
    const memberWhere = read.compose(
      {
        tenant: organizationMembers.orgId,
        scope: { columns: { ownerColumn: organizationMembers.userId } },
        and: [eq(organizationMembers.status, "ACTIVE")],
      },
      ({ sql: where }) => where,
      () => sql`false`,
    );
    const presentToday = read.compose(
      {
        tenant: attendance.orgId,
        scope: { columns: { ownerColumn: attendance.userId } },
        and: [eq(attendance.date, today)],
      },
      ({ sql: where }) => where,
      () => sql`false`,
    );

    const [totalMembersResult, todayAttendance, presenceCounts] =
      await Promise.all([
        this.db
          .select({ count: sql<number>`count(*)::int` })
          .from(organizationMembers)
          .where(memberWhere),
        this.db
          .select({
            userId: attendance.userId,
            userName: users.name,
            userImage: users.image,
            userDesignation: hrEmployments.designation,
            checkIn: attendance.checkIn,
            checkOut: attendance.checkOut,
            status: attendance.status,
            createdAt: attendance.createdAt,
          })
          .from(attendance)
          .innerJoin(users, eq(attendance.userId, users.id))
          .leftJoin(hrPeople, livePersonOfUser(orgId, users.id))
          .leftJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
          .where(presentToday)
          .orderBy(asc(attendance.userId), desc(attendance.createdAt))
          .limit(DASHBOARD_ATTENDANCE_ROW_CAP),
        this.db
          .select({
            present: countDistinct(attendance.userId),
            clockedIn: sql<number>`count(distinct ${attendance.userId}) filter (where ${attendance.checkIn} is not null and ${attendance.checkOut} is null)::int`,
          })
          .from(attendance)
          .where(presentToday),
      ]);

    const byUser = new Map<string, (typeof todayAttendance)[number]>();
    for (const record of todayAttendance) {
      const existing = byUser.get(record.userId);
      if (!existing) {
        byUser.set(record.userId, record);
        continue;
      }
      const recordOpen = Boolean(record.checkIn) && !record.checkOut;
      const existingOpen = Boolean(existing.checkIn) && !existing.checkOut;
      if (recordOpen && !existingOpen) {
        byUser.set(record.userId, record);
        continue;
      }
      if (recordOpen === existingOpen) {
        const recordCreated = record.createdAt
          ? new Date(record.createdAt).getTime()
          : 0;
        const existingCreated = existing.createdAt
          ? new Date(existing.createdAt).getTime()
          : 0;
        if (recordCreated > existingCreated) byUser.set(record.userId, record);
      }
    }

    const latestRecords = [...byUser.values()].map((record) => ({
      userId: record.userId,
      userName: record.userName,
      userImage: record.userImage,
      userDesignation: record.userDesignation,
      checkIn: record.checkIn,
      checkOut: record.checkOut,
      status: record.status,
    }));
    const total = totalMembersResult[0]?.count ?? 0;
    const present = Number(presenceCounts[0]?.present ?? latestRecords.length);
    const clockedIn = Number(presenceCounts[0]?.clockedIn ?? 0);

    return {
      total,
      present,
      clockedIn,
      absent: total - present,
      records: latestRecords,
      hasMore: present > latestRecords.length,
    };
  }
}
