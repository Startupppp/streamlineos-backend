import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { and, count, desc, eq, gt, isNull, lt } from "drizzle-orm";
import { addDays, addMinutes } from "date-fns";
import { hashToken } from "../../common/security/token.util";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { EmailService } from "../email/email.service";
import { PlanLimitsService } from "../billing/plan-limits.service";
import {
  invitations,
  magicLinkTokens,
  organizationMembers,
  organizations,
  users,
} from "../../db/schema";
import type { AcceptInvitationInput } from "./dto/organization.schemas";

@Injectable()
export class InvitationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly email: EmailService,
    private readonly planLimits: PlanLimitsService,
  ) {}

  async invite(
    orgId: string,
    actorUserId: string,
    email: string,
    role: string,
  ): Promise<{ success: true; invitationId: string; organizationName: string; resent: boolean }> {
    const existingUser = await this.db.query.users.findFirst({
      where: eq(users.email, email),
    });

    if (existingUser) {
      const existingMember = await this.db.query.organizationMembers.findFirst({
        where: and(
          eq(organizationMembers.userId, existingUser.id),
          eq(organizationMembers.orgId, orgId),
        ),
      });
      if (existingMember) throw new ConflictException("User is already a member");
    }

    const org = await this.db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
    });

    if (org?.allowedEmailDomains && org.allowedEmailDomains.length > 0) {
      const emailDomain = email.split("@")[1]?.toLowerCase();
      const allowed = org.allowedEmailDomains.map((d) => d.toLowerCase());
      if (!emailDomain || !allowed.includes(emailDomain)) {
        throw new BadRequestException(
          `Email domain not allowed. Permitted: ${org.allowedEmailDomains.join(", ")}`,
        );
      }
    }

    const now = new Date();

    const pendingResult = await this.db.transaction(async (tx) => {
      const pending = await tx
        .select()
        .from(invitations)
        .where(
          and(
            eq(invitations.email, email),
            eq(invitations.orgId, orgId),
            gt(invitations.expiresAt, now),
            isNull(invitations.acceptedAt),
          ),
        )
        .for("update")
        .limit(1);
      const pendingInvitation = pending[0];
      if (!pendingInvitation) return null;

      const rawToken = randomBytes(32).toString("hex");
      const newExpiresAt = addDays(now, 7);

      await tx
        .update(invitations)
        .set({ token: hashToken(rawToken), expiresAt: newExpiresAt, role, invitedBy: actorUserId })
        .where(eq(invitations.id, pendingInvitation.id));

      return { pendingInvitation, rawToken };
    });

    if (pendingResult) {
      const { pendingInvitation, rawToken } = pendingResult;
      void this.email
        .sendInvitationEmail(email, rawToken, org?.name ?? "Your Organization")
        .catch(() => {});

      this.audit.log({
        action: "user.invitation.resent",
        userId: actorUserId,
        orgId,
        targetId: pendingInvitation.id,
        targetType: "invitation",
        metadata: { email, role },
      });

      return { success: true, invitationId: pendingInvitation.id, organizationName: org?.name ?? "", resent: true };
    }

    await this.planLimits.assertWithinLimit(orgId, "members");

    const invitationId = randomUUID();
    const rawToken = randomBytes(32).toString("hex");
    const expiresAt = addDays(now, 7);

    try {
      await this.db.transaction(async (tx) => {
        await tx
          .delete(invitations)
          .where(
            and(
              eq(invitations.email, email),
              eq(invitations.orgId, orgId),
              isNull(invitations.acceptedAt),
            ),
          );

        await tx.insert(invitations).values({
          id: invitationId,
          email,
          token: hashToken(rawToken),
          orgId,
          role,
          invitedBy: actorUserId,
          expiresAt,
        });
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "23505") {
        throw new ConflictException("An invitation is already pending for this email");
      }
      throw err;
    }

    void this.email
      .sendInvitationEmail(email, rawToken, org?.name ?? "Your Organization")
      .catch(() => {});

    this.audit.log({
      action: "user.invited",
      userId: actorUserId,
      orgId,
      targetId: invitationId,
      targetType: "invitation",
      metadata: { email, role },
    });

    return { success: true, invitationId, organizationName: org?.name ?? "", resent: false };
  }

  async bulkInvite(
    orgId: string,
    actorUserId: string,
    emails: string[],
    role: string,
  ): Promise<{
    results: Array<{ email: string; success: boolean; invitationId?: string; error?: string }>;
  }> {
    const results: Array<{
      email: string;
      success: boolean;
      invitationId?: string;
      error?: string;
    }> = [];

    for (const email of emails) {
      try {
        const result = await this.invite(orgId, actorUserId, email, role);
        results.push({ email, success: true, invitationId: result.invitationId });
      } catch (err) {
        results.push({
          email,
          success: false,
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }

    return { results };
  }

  listPending(orgId: string) {
    return this.db
      .select({
        id: invitations.id,
        email: invitations.email,
        role: invitations.role,
        expiresAt: invitations.expiresAt,
        createdAt: invitations.createdAt,
      })
      .from(invitations)
      .where(
        and(
          eq(invitations.orgId, orgId),
          eq(invitations.status, "PENDING"),
          isNull(invitations.acceptedAt),
          gt(invitations.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(invitations.createdAt));
  }

  async listPaginated(
    orgId: string,
    params?: { page?: number; limit?: number; includeAccepted?: boolean },
  ) {
    const page = params?.page ?? 1;
    const limit = Math.min(params?.limit ?? 20, 100);
    const offset = (page - 1) * limit;

    const conditions = [eq(invitations.orgId, orgId)];
    if (!params?.includeAccepted) {
      conditions.push(eq(invitations.status, "PENDING"));
      conditions.push(isNull(invitations.acceptedAt));
    }

    const [data, countResult] = await Promise.all([
      this.db
        .select({
          id: invitations.id,
          email: invitations.email,
          role: invitations.role,
          invitedBy: invitations.invitedBy,
          expiresAt: invitations.expiresAt,
          acceptedAt: invitations.acceptedAt,
          createdAt: invitations.createdAt,
        })
        .from(invitations)
        .where(and(...conditions))
        .orderBy(desc(invitations.createdAt))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(invitations).where(and(...conditions)),
    ]);

    return {
      data,
      pagination: {
        page,
        limit,
        total: countResult[0]?.total ?? 0,
        totalPages: Math.ceil((countResult[0]?.total ?? 0) / limit),
      },
    };
  }

  async validate(
    token: string,
  ): Promise<{ email: string; organizationName: string; role: string; userExists: boolean }> {
    const invitation = await this.db.query.invitations.findFirst({
      where: and(
        eq(invitations.token, hashToken(token)),
        gt(invitations.expiresAt, new Date()),
        isNull(invitations.acceptedAt),
      ),
    });
    if (!invitation) throw new NotFoundException("Invalid or expired invitation");

    const [org, existingUser] = await Promise.all([
      this.db.query.organizations.findFirst({
        where: eq(organizations.id, invitation.orgId),
        columns: { name: true },
      }),
      this.db.query.users.findFirst({
        where: eq(users.email, invitation.email),
        columns: { id: true },
      }),
    ]);

    return {
      email: invitation.email,
      organizationName: org?.name ?? "Unknown",
      role: invitation.role,
      userExists: !!existingUser,
    };
  }

  async accept(input: AcceptInvitationInput): Promise<{ ok: boolean; autoLoginToken?: string }> {
    const invitation = await this.db.query.invitations.findFirst({
      where: and(
        eq(invitations.token, hashToken(input.token)),
        gt(invitations.expiresAt, new Date()),
        isNull(invitations.acceptedAt),
      ),
    });
    if (!invitation) throw new NotFoundException("Invalid or expired invitation");

    const existingUser = await this.db.query.users.findFirst({
      where: eq(users.email, invitation.email),
    });

    if (existingUser) {
      const existingMembership = await this.db.query.organizationMembers.findFirst({
        where: and(
          eq(organizationMembers.userId, existingUser.id),
          eq(organizationMembers.orgId, invitation.orgId),
        ),
      });
      if (existingMembership)
        throw new ConflictException("You are already a member of this organization");

      await this.db.transaction(async (tx) => {
        const inserted = await tx
          .insert(organizationMembers)
          .values({ userId: existingUser.id, orgId: invitation.orgId, role: invitation.role })
          .onConflictDoNothing()
          .returning({ id: organizationMembers.id });
        const membershipId = inserted[0]?.id ?? null;
        await tx
          .update(users)
          .set({ lastActiveOrgId: invitation.orgId })
          .where(eq(users.id, existingUser.id));
        await tx
          .update(invitations)
          .set({
            acceptedAt: new Date(),
            status: "ACCEPTED",
            ...(membershipId !== null ? { acceptedMembershipId: membershipId } : {}),
          })
          .where(eq(invitations.id, invitation.id));
      });

      const autoLoginToken = randomBytes(32).toString("hex");
      await this.db.insert(magicLinkTokens).values({
        id: randomUUID(),
        userId: existingUser.id,
        tokenHash: createHash("sha256").update(autoLoginToken).digest("hex"),
        expiresAt: addMinutes(new Date(), 10),
      });
      await this.cache.invalidate(CACHE_KEYS.userSession(existingUser.id));

      return { ok: true, autoLoginToken };
    }

    const userId = randomUUID();
    const firstName = input.firstName?.trim() || null;
    const lastName = input.lastName?.trim() || null;
    const fromNames = [firstName, lastName].filter(Boolean).join(" ") || null;
    const emailLocal = invitation.email.split("@")[0]?.trim() || null;
    const fullName = fromNames ?? emailLocal;

    await this.db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId,
        email: invitation.email,
        name: fullName,
        firstName,
        lastName,
        emailVerified: new Date(),
        role: invitation.role,
        hasDashboardAccess: true,
        lastActiveOrgId: invitation.orgId,
      });
      const inserted = await tx
        .insert(organizationMembers)
        .values({ userId, orgId: invitation.orgId, role: invitation.role })
        .onConflictDoNothing()
        .returning({ id: organizationMembers.id });
      const membershipId = inserted[0]?.id ?? null;
      await tx
        .update(invitations)
        .set({
          acceptedAt: new Date(),
          status: "ACCEPTED",
          ...(membershipId !== null ? { acceptedMembershipId: membershipId } : {}),
        })
        .where(eq(invitations.id, invitation.id));
    });

    const autoLoginToken = randomBytes(32).toString("hex");
    await this.db.insert(magicLinkTokens).values({
      id: randomUUID(),
      userId,
      tokenHash: createHash("sha256").update(autoLoginToken).digest("hex"),
      expiresAt: addMinutes(new Date(), 10),
    });
    await this.cache.invalidate(CACHE_KEYS.userSession(userId));

    return { ok: true, autoLoginToken };
  }

  async resend(
    orgId: string,
    invitationId: string,
    actorUserId: string,
  ): Promise<{ success: true }> {
    const invitation = await this.db.query.invitations.findFirst({
      where: and(
        eq(invitations.id, invitationId),
        eq(invitations.orgId, orgId),
        isNull(invitations.acceptedAt),
      ),
    });
    if (!invitation) throw new NotFoundException("Invitation not found or already accepted");

    const rawToken = randomBytes(32).toString("hex");
    const newExpiresAt = addDays(new Date(), 7);

    await this.db
      .update(invitations)
      .set({ token: hashToken(rawToken), expiresAt: newExpiresAt })
      .where(eq(invitations.id, invitationId));

    const [org, inviter] = await Promise.all([
      this.db.query.organizations.findFirst({
        where: eq(organizations.id, orgId),
        columns: { name: true },
      }),
      this.db.query.users.findFirst({
        where: eq(users.id, actorUserId),
        columns: { name: true, firstName: true, lastName: true },
      }),
    ]);

    const inviterName =
      inviter?.firstName && inviter?.lastName
        ? `${inviter.firstName} ${inviter.lastName}`
        : inviter?.name ?? undefined;

    void this.email
      .sendInvitationEmail(
        invitation.email,
        rawToken,
        org?.name ?? "Your Organization",
        inviterName,
      )
      .catch(() => {});

    this.audit.log({
      action: "user.invitation.resent",
      userId: actorUserId,
      orgId,
      targetId: invitationId,
      targetType: "invitation",
      metadata: { email: invitation.email },
    });

    return { success: true };
  }

  async cancel(
    orgId: string,
    invitationId: string,
    actorUserId: string,
  ): Promise<{ success: true }> {
    const invitation = await this.db.query.invitations.findFirst({
      where: and(
        eq(invitations.id, invitationId),
        eq(invitations.orgId, orgId),
        eq(invitations.status, "PENDING"),
        isNull(invitations.acceptedAt),
      ),
    });
    if (!invitation) throw new NotFoundException("Invitation not found or already accepted");

    const actorMembership = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, actorUserId),
      ),
      columns: { id: true },
    });

    await this.db
      .update(invitations)
      .set({
        status: "REVOKED",
        revokedAt: new Date(),
        revokedBy: actorMembership?.id ?? null,
      })
      .where(eq(invitations.id, invitationId));

    this.audit.log({
      action: "user.invitation.cancelled",
      userId: actorUserId,
      orgId,
      targetId: invitationId,
      targetType: "invitation",
      metadata: { email: invitation.email },
    });

    return { success: true };
  }

  async expireStaleInvitations(): Promise<{ expired: number }> {
    const now = new Date();
    const result = await this.db
      .update(invitations)
      .set({ status: "EXPIRED" })
      .where(
        and(
          eq(invitations.status, "PENDING"),
          lt(invitations.expiresAt, now),
        ),
      )
      .returning({ id: invitations.id });
    return { expired: result.length };
  }
}
