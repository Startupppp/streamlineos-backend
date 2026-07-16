import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import bcrypt from "bcryptjs";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { and, count, desc, eq, gt, isNull } from "drizzle-orm";
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

type InviteExtra = {
  employeeId?: string;
  branchId?: number;
  departmentId?: number;
  teamId?: string;
  managerUserId?: string;
  startDate?: string;
  welcomeMessage?: string;
};

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
    extra?: InviteExtra,
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

    await this.planLimits.assertWithinLimit(orgId, "members");

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

    const pendingInvitation = await this.db.query.invitations.findFirst({
      where: and(
        eq(invitations.email, email),
        eq(invitations.orgId, orgId),
        gt(invitations.expiresAt, now),
        isNull(invitations.acceptedAt),
      ),
    });

    if (pendingInvitation) {
      const rawToken = randomBytes(32).toString("hex");
      const newExpiresAt = addDays(now, 7);

      await this.db
        .update(invitations)
        .set({ token: hashToken(rawToken), expiresAt: newExpiresAt, role, invitedBy: actorUserId })
        .where(eq(invitations.id, pendingInvitation.id));

      void this.email
        .sendInvitationEmail(email, rawToken, org?.name ?? "Your Organization")
        .catch(() => {});

      this.audit.log({
        action: "user.invitation.resent",
        userId: actorUserId,
        orgId,
        targetId: pendingInvitation.id,
        targetType: "invitation",
        metadata: { email, role, ...extra },
      });

      return { success: true, invitationId: pendingInvitation.id, organizationName: org?.name ?? "", resent: true };
    }

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
      metadata: { email, role, ...extra },
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
        await tx
          .insert(organizationMembers)
          .values({ userId: existingUser.id, orgId: invitation.orgId, role: invitation.role })
          .onConflictDoNothing();
        await tx
          .update(users)
          .set({ lastActiveOrgId: invitation.orgId })
          .where(eq(users.id, existingUser.id));
        await tx
          .update(invitations)
          .set({ acceptedAt: new Date() })
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

    if (!input.password) throw new BadRequestException("Password is required for new accounts");

    const hashedPassword = await bcrypt.hash(input.password, 12);
    const userId = randomUUID();
    const fullName =
      input.firstName && input.lastName
        ? `${input.firstName} ${input.lastName}`
        : input.firstName || input.lastName || null;

    await this.db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId,
        email: invitation.email,
        password: hashedPassword,
        name: fullName,
        firstName: input.firstName,
        lastName: input.lastName,
        emailVerified: new Date(),
        role: invitation.role,
        hasDashboardAccess: true,
        lastActiveOrgId: invitation.orgId,
      });
      await tx
        .insert(organizationMembers)
        .values({ userId, orgId: invitation.orgId, role: invitation.role })
        .onConflictDoNothing();
      await tx
        .update(invitations)
        .set({ acceptedAt: new Date() })
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
        isNull(invitations.acceptedAt),
      ),
    });
    if (!invitation) throw new NotFoundException("Invitation not found or already accepted");

    await this.db.delete(invitations).where(eq(invitations.id, invitationId));

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
}
