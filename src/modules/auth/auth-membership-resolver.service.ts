import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { addDays } from "date-fns";
import {
  accountOrganizationIndex,
  organizationMembers,
  organizations,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { withIdentity } from "../../common/tenant/with-identity";
import { SessionsService } from "../sessions/sessions.service";

@Injectable()
export class AuthMembershipResolverService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly sessions: SessionsService,
  ) {}

  async resolvePreferredOrgId(userId: string): Promise<string | null> {
    const rows = await withIdentity(this.db, userId, (tx) =>
      tx
        .select({ orgId: accountOrganizationIndex.orgId })
        .from(accountOrganizationIndex)
        .where(eq(accountOrganizationIndex.userId, userId))
        .orderBy(
          sql`${accountOrganizationIndex.lastActivatedAt} DESC NULLS LAST`,
          desc(accountOrganizationIndex.joinedAt),
        )
        .limit(1),
    );
    return rows[0]?.orgId ?? null;
  }

  async resolveActiveMembership(
    userId: string,
    preferredOrgId: string | null,
    options?: { honorSuspendedPreference?: boolean },
  ): Promise<{
    orgId: string;
    isOwner: boolean;
    role: string;
    maxConcurrentSessions: number | null;
    orgOnboardingCompletedAt: Date | null;
    memberOnboardingCompletedAt: Date | null;
  } | null> {
    const rows = await withIdentity(this.db, userId, async (tx) =>
      tx
        .select({
          orgId: organizationMembers.orgId,
          isOwner: organizationMembers.isOwner,
          role: organizationMembers.role,
          status: organizationMembers.status,
          maxConcurrentSessions: organizations.maxConcurrentSessions,
          orgOnboardingCompletedAt: organizations.onboardingCompletedAt,
          memberOnboardingCompletedAt: organizationMembers.onboardingCompletedAt,
        })
        .from(organizationMembers)
        .innerJoin(
          organizations,
          eq(organizations.id, organizationMembers.orgId),
        )
        .where(
          and(
            eq(organizationMembers.userId, userId),
            options?.honorSuspendedPreference
              ? inArray(organizationMembers.status, ["ACTIVE", "SUSPENDED"])
              : eq(organizationMembers.status, "ACTIVE"),
            eq(organizations.status, "ACTIVE"),
            isNull(organizations.deletedAt),
          ),
        )
        .orderBy(desc(organizationMembers.joinedAt)),
    );

    if (preferredOrgId) {
      const preferred = rows.find((r) => r.orgId === preferredOrgId);
      if (
        options?.honorSuspendedPreference &&
        preferred?.status === "SUSPENDED"
      )
        return null;
      if (preferred?.status === "ACTIVE") return preferred;
    }
    return rows.find((row) => row.status === "ACTIVE") ?? null;
  }

  async resolveSuspendedMembership(
    userId: string,
    preferredOrgId: string | null,
  ): Promise<{ orgId: string; orgName: string } | null> {
    const rows = await withIdentity(this.db, userId, async (tx) =>
      tx
        .select({
          orgId: organizationMembers.orgId,
          orgName: organizations.name,
        })
        .from(organizationMembers)
        .innerJoin(
          organizations,
          eq(organizations.id, organizationMembers.orgId),
        )
        .where(
          and(
            eq(organizationMembers.userId, userId),
            eq(organizationMembers.status, "SUSPENDED"),
            eq(organizations.status, "ACTIVE"),
            isNull(organizations.deletedAt),
          ),
        )
        .orderBy(
          desc(organizationMembers.suspendedAt),
          desc(organizationMembers.joinedAt),
        ),
    );

    if (preferredOrgId) {
      const preferred = rows.find((row) => row.orgId === preferredOrgId);
      if (preferred) return preferred;
    }
    return rows[0] ?? null;
  }

  async createLoginSession(
    userId: string,
    context: { userAgent?: string; ipAddress?: string },
    maxConcurrentSessionsCap?: number | null,
  ): Promise<string> {
    const sessionId = await this.sessions.create({
      userId,
      userAgent: context.userAgent,
      ipAddress: context.ipAddress,
      expiresAt: addDays(new Date(), 30),
    });

    const cap =
      maxConcurrentSessionsCap !== undefined
        ? maxConcurrentSessionsCap
        : ((await this.resolveActiveMembership(userId, null))?.maxConcurrentSessions ?? null);
    if (cap !== null)
      await this.sessions.enforceMaxSessions(userId, cap, sessionId);

    return sessionId;
  }
}
