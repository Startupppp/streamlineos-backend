import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Logger,
} from "@nestjs/common";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import {
  and,
  count,
  desc,
  eq,
  gt,
  ilike,
  isNull,
  lt,
  inArray,
  or,
  sql,
} from "drizzle-orm";
import { addDays, addMinutes } from "date-fns";
import { hashToken } from "../../../common/security/token.util";
import { withPublicToken } from "../../../common/tenant/with-public-token";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AccessService } from "../../access/access.service";
import { assertMayGrantRole } from "../../../common/rbac/assert-may-grant-role";
import { syncStructuralRoleAssignment } from "../../../common/rbac/sync-structural-role";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { bustUsersStatsCache } from "../../../common/cache/bust-users-stats";
import { bustMembershipStatusCache } from "../../../common/auth/membership-state.service";
import { EmailService } from "../../email/email.service";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import {
  invitationEvents,
  invitations,
  magicLinkTokens,
  organizationAllowedEmailDomains,
  organizationMembers,
  organizations,
  users,
} from "../../../db/schema";
import type { AcceptInvitationInput } from "./dto/organization.schemas";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";

export interface InviteActor {
  userId: string;
  isOrgOwner: boolean;
}

@Injectable()
export class InvitationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly email: EmailService,
    private readonly planLimits: PlanLimitsService,
    private readonly access: AccessService,
  ) {}

  private readonly logger = new Logger(InvitationsService.name);

  private async recordDeliveryFailure(
    orgId: string,
    invitationId: string,
    err: unknown,
  ): Promise<void> {
    this.logger.error(
      `Invitation email delivery failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    try {
      await runInTenantTransaction(
        this.db,
        (tx) =>
          tx.insert(invitationEvents).values({
            orgId,
            invitationId,
            event: "DELIVERY_FAILED",
            actorMembershipId: null,
          }),
        { orgId },
      );
    } catch (recordErr: unknown) {
      this.logger.error(
        `Failed to record invitation delivery failure: ${recordErr instanceof Error ? recordErr.message : String(recordErr)}`,
      );
    }
  }

  private assertMayInviteWithRole(
    orgId: string,
    actor: InviteActor,
    role: string,
  ): Promise<void> {
    return assertMayGrantRole(this.access, orgId, actor, role);
  }

  private async requireActiveOrg(orgId: string): Promise<{ name: string }> {
    const org = await this.db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
      columns: { name: true, status: true, deletedAt: true },
    });
    if (!org || org.status !== "ACTIVE" || org.deletedAt !== null) {
      throw new BadRequestException(
        "This organization is archived or unavailable. Restore it before inviting or accepting members.",
      );
    }
    return { name: org.name };
  }

  private async lockPendingInvitation(
    tx: DbOrTx,
    invitationId: string,
    tokenHash: string,
  ) {
    const [invitation] = await tx
      .select({
        id: invitations.id,
        orgId: invitations.orgId,
        email: invitations.email,
        role: invitations.role,
      })
      .from(invitations)
      .where(
        and(
          eq(invitations.id, invitationId),
          eq(invitations.tokenHash, tokenHash),
          eq(invitations.status, "PENDING"),
          gt(invitations.expiresAt, new Date()),
          isNull(invitations.acceptedAt),
        ),
      )
      .for("update")
      .limit(1);
    if (!invitation) {
      throw new ConflictException("Invitation has already been accepted");
    }
    return invitation;
  }

  async revokeAllPending(orgId: string, existingTx?: DbOrTx): Promise<number> {
    const now = new Date();
    const revoke = async (tx: DbOrTx) => {
      const rows = await tx
        .update(invitations)
        .set({
          status: "REVOKED",
          revokedAt: now,
          revokedByMembershipId: null,
        })
        .where(
          and(
            eq(invitations.orgId, orgId),
            eq(invitations.status, "PENDING"),
            isNull(invitations.acceptedAt),
          ),
        )
        .returning({ id: invitations.id });
      if (rows.length > 0) {
        await tx.insert(invitationEvents).values(
          rows.map((r) => ({
            orgId,
            invitationId: r.id,
            event: "REVOKED" as const,
            actorMembershipId: null,
          })),
        );
      }
      return rows;
    };
    const updated = existingTx
      ? await revoke(existingTx)
      : await runInTenantTransaction(this.db, revoke, { orgId });
    if (!existingTx && updated.length > 0) {
      await bustUsersStatsCache(this.cache, orgId);
    }
    return updated.length;
  }

  async invite(
    orgId: string,
    actor: InviteActor,
    email: string,
    role: string,
  ): Promise<{
    success: true;
    invitationId: string;
    organizationName: string;
    resent: boolean;
  }> {
    const actorUserId = actor.userId;
    await this.assertMayInviteWithRole(orgId, actor, role);
    const org = await this.requireActiveOrg(orgId);

    const existingUser = await this.db.query.users.findFirst({
      where: eq(users.email, email),
    });

    if (existingUser) {
      const existingMember = await this.db.query.organizationMembers.findFirst({
        where: and(
          eq(organizationMembers.userId, existingUser.id),
          eq(organizationMembers.orgId, orgId),
        ),
        columns: { status: true },
      });
      if (existingMember) {
        if (
          existingMember.status === "SUSPENDED" ||
          existingMember.status === "LEFT"
        ) {
          throw new ConflictException(
            "This person was archived/suspended in this organization. Restore them from Users instead of inviting again.",
          );
        }
        throw new ConflictException("User is already a member");
      }
    }

    const allowedDomainRows = await this.db
      .select({ domain: organizationAllowedEmailDomains.domain })
      .from(organizationAllowedEmailDomains)
      .where(eq(organizationAllowedEmailDomains.orgId, orgId));

    if (allowedDomainRows.length > 0) {
      const emailDomain = email.split("@")[1]?.toLowerCase();
      const allowed = allowedDomainRows.map((r) => r.domain);
      if (!emailDomain || !allowed.includes(emailDomain)) {
        throw new BadRequestException(
          `Email domain not allowed. Permitted: ${allowed.join(", ")}`,
        );
      }
    }

    const now = new Date();

    const pendingResult = await runInTenantTransaction(
      this.db,
      async (tx) => {
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
          .set({
            tokenHash: hashToken(rawToken),
            expiresAt: newExpiresAt,
            role,
            invitedBy: actorUserId,
            status: "PENDING",
            revokedAt: null,
            revokedByMembershipId: null,
            declinedAt: null,
          })
          .where(eq(invitations.id, pendingInvitation.id));

        await tx.insert(invitationEvents).values({
          orgId,
          invitationId: pendingInvitation.id,
          event: "RESENT",
          actorMembershipId: null,
        });

        return { pendingInvitation, rawToken };
      },
      { orgId },
    );

    if (pendingResult) {
      const { pendingInvitation, rawToken } = pendingResult;
      void this.email
        .sendInvitationEmail(email, rawToken, org.name)
        .catch((err: unknown) =>
          this.recordDeliveryFailure(orgId, pendingInvitation.id, err),
        );

      this.audit.log({
        action: "user.invitation.resent",
        userId: actorUserId,
        orgId,
        targetId: pendingInvitation.id,
        targetType: "invitation",
        metadata: { email, role },
      });

      await bustUsersStatsCache(this.cache, orgId);
      return {
        success: true,
        invitationId: pendingInvitation.id,
        organizationName: org.name,
        resent: true,
      };
    }

    const invitationId = randomUUID();
    const rawToken = randomBytes(32).toString("hex");
    const expiresAt = addDays(now, 7);

    try {
      await runInTenantTransaction(
        this.db,
        async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${`quota:${orgId}:members`}, 0))`,
          );
          await this.planLimits.assertWithinLimit(orgId, "members", 1, tx);
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
            tokenHash: hashToken(rawToken),
            orgId,
            role,
            invitedBy: actorUserId,
            expiresAt,
          });

          await tx.insert(invitationEvents).values({
            orgId,
            invitationId,
            event: "CREATED",
            actorMembershipId: null,
          });
        },
        { orgId },
      );
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "23505") {
        throw new ConflictException(
          "An invitation is already pending for this email",
        );
      }
      throw err;
    }

    void this.email
      .sendInvitationEmail(email, rawToken, org.name)
      .catch((err: unknown) =>
        this.recordDeliveryFailure(orgId, invitationId, err),
      );

    this.audit.log({
      action: "user.invited",
      userId: actorUserId,
      orgId,
      targetId: invitationId,
      targetType: "invitation",
      metadata: { email, role },
    });

    await bustUsersStatsCache(this.cache, orgId);
    return {
      success: true,
      invitationId,
      organizationName: org.name,
      resent: false,
    };
  }

  async bulkInvite(
    orgId: string,
    actor: InviteActor,
    emails: string[],
    role: string,
  ): Promise<{
    results: Array<{
      email: string;
      success: boolean;
      invitationId?: string;
      error?: string;
    }>;
  }> {
    const results: Array<{
      email: string;
      success: boolean;
      invitationId?: string;
      error?: string;
    }> = [];

    for (const email of emails) {
      try {
        const result = await this.invite(orgId, actor, email, role);
        results.push({
          email,
          success: true,
          invitationId: result.invitationId,
        });
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

  async listPaginated(
    orgId: string,
    params?: {
      page?: number;
      limit?: number;
      includeAccepted?: boolean;
      status?: "pending" | "accepted" | "expired" | "revoked";
      q?: string;
    },
  ) {
    const page = params?.page ?? 1;
    const limit = Math.min(params?.limit ?? 20, 100);
    const offset = (page - 1) * limit;
    const now = new Date();

    const conditions = [eq(invitations.orgId, orgId)];
    if (params?.status === "pending") {
      conditions.push(eq(invitations.status, "PENDING"));
      conditions.push(isNull(invitations.acceptedAt));
      conditions.push(gt(invitations.expiresAt, now));
    } else if (params?.status === "accepted") {
      conditions.push(eq(invitations.status, "ACCEPTED"));
    } else if (params?.status === "revoked") {
      conditions.push(eq(invitations.status, "REVOKED"));
    } else if (params?.status === "expired") {
      const expiredFilter = or(
        eq(invitations.status, "EXPIRED"),
        and(
          eq(invitations.status, "PENDING"),
          isNull(invitations.acceptedAt),
          lt(invitations.expiresAt, now),
        ),
      );
      if (expiredFilter) conditions.push(expiredFilter);
    } else if (!params?.includeAccepted) {
      conditions.push(eq(invitations.status, "PENDING"));
      conditions.push(isNull(invitations.acceptedAt));
    }

    const q = params?.q?.trim();
    if (q) {
      const escaped = q.replace(/[%_\\]/g, (m) => `\\${m}`);
      conditions.push(ilike(invitations.email, `${escaped}%`));
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
          status: invitations.status,
          revokedAt: invitations.revokedAt,
          deliveryFailed: sql<boolean>`EXISTS (
            SELECT 1 FROM ${invitationEvents} f
            WHERE f.invitation_id = "invitations"."id"
              AND f.org_id = ${orgId}
              AND f.event = 'DELIVERY_FAILED'
              AND f.created_at > COALESCE(
                (
                  SELECT MAX(r.created_at) FROM ${invitationEvents} r
                  WHERE r.invitation_id = "invitations"."id"
                    AND r.org_id = ${orgId}
                    AND r.event = 'RESENT'
                ),
                "invitations"."created_at"
              )
          )`,
        })
        .from(invitations)
        .where(and(...conditions))
        .orderBy(desc(invitations.createdAt))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(invitations)
        .where(and(...conditions)),
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

  async validate(token: string): Promise<{
    email: string;
    organizationName: string;
    role: string;
    userExists: boolean;
  }> {
    const invitation = await this.db.query.invitations.findFirst({
      where: and(
        eq(invitations.tokenHash, hashToken(token)),
        eq(invitations.status, "PENDING"),
        gt(invitations.expiresAt, new Date()),
        isNull(invitations.acceptedAt),
      ),
    });
    if (!invitation)
      throw new NotFoundException("Invalid or expired invitation");

    const [org, existingUser] = await Promise.all([
      this.requireActiveOrg(invitation.orgId),
      this.db.query.users.findFirst({
        where: eq(users.email, invitation.email),
        columns: { id: true },
      }),
    ]);

    return {
      email: invitation.email,
      organizationName: org.name,
      role: invitation.role,
      userExists: !!existingUser,
    };
  }

  async accept(
    input: AcceptInvitationInput,
  ): Promise<{ ok: boolean; autoLoginToken?: string }> {
    const tokenHash = hashToken(input.token);
    const invitation = await withPublicToken(this.db, tokenHash, (tx) =>
      tx.query.invitations.findFirst({
        where: and(
          eq(invitations.tokenHash, tokenHash),
          eq(invitations.status, "PENDING"),
          gt(invitations.expiresAt, new Date()),
          isNull(invitations.acceptedAt),
        ),
      }),
    );
    if (!invitation)
      throw new NotFoundException("Invalid or expired invitation");
    await this.requireActiveOrg(invitation.orgId);
    const invitedOrgId = invitation.orgId;

    const existingUser = await this.db.query.users.findFirst({
      where: eq(users.email, invitation.email),
    });

    if (existingUser) {
      const existingMembership =
        await this.db.query.organizationMembers.findFirst({
          where: and(
            eq(organizationMembers.userId, existingUser.id),
            eq(organizationMembers.orgId, invitation.orgId),
          ),
          columns: { status: true },
        });
      if (existingMembership) {
        if (
          existingMembership.status === "SUSPENDED" ||
          existingMembership.status === "LEFT"
        ) {
          throw new ConflictException(
            "Your membership in this organization is archived or suspended. Ask an admin to restore you from Users.",
          );
        }
        throw new ConflictException(
          "You are already a member of this organization",
        );
      }

      const autoLoginToken = randomBytes(32).toString("hex");
      await runInTenantTransaction(
        this.db,
        async (tx) => {
          const lockedInvitation = await this.lockPendingInvitation(
            tx,
            invitation.id,
            tokenHash,
          );
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${`quota:${invitation.orgId}:members`}, 0))`,
          );
          try {
            await this.planLimits.assertWithinLimit(
              invitation.orgId,
              "members",
              0,
              tx,
            );
          } catch (err) {
            if (err instanceof ForbiddenException) {
              throw new ForbiddenException(
                "This organization has reached its member limit. Ask an admin to upgrade the plan or free a seat.",
              );
            }
            throw err;
          }
          const inserted = await tx
            .insert(organizationMembers)
            .values({
              userId: existingUser.id,
              orgId: lockedInvitation.orgId,
              role: lockedInvitation.role,
            })
            .onConflictDoNothing()
            .returning({ id: organizationMembers.id });
          const membershipId = inserted[0]?.id;
          if (membershipId === undefined) {
            throw new ConflictException(
              "You are already a member of this organization",
            );
          }
          await syncStructuralRoleAssignment(
            tx,
            lockedInvitation.orgId,
            membershipId,
            lockedInvitation.role,
          );

          await tx
            .update(users)
            .set({ lastActiveOrgId: lockedInvitation.orgId })
            .where(eq(users.id, existingUser.id));
          const claimedRows = await tx
            .update(invitations)
            .set({
              acceptedAt: new Date(),
              status: "ACCEPTED",
              acceptedMembershipId: membershipId,
            })
            .where(
              and(
                eq(invitations.id, invitation.id),
                eq(invitations.status, "PENDING"),
                isNull(invitations.acceptedAt),
              ),
            )
            .returning({ id: invitations.id });
          if (claimedRows.length === 0)
            throw new NotFoundException("Invalid or expired invitation");
          await tx.insert(invitationEvents).values({
            orgId: invitation.orgId,
            invitationId: invitation.id,
            event: "ACCEPTED",
            actorMembershipId: membershipId,
          });
          await tx.insert(magicLinkTokens).values({
            id: randomUUID(),
            userId: existingUser.id,
            tokenHash: createHash("sha256")
              .update(autoLoginToken)
              .digest("hex"),
            expiresAt: addMinutes(new Date(), 10),
          });
        },
        { orgId: invitedOrgId },
      );
      await Promise.all([
        this.cache.invalidate(CACHE_KEYS.userSession(existingUser.id)),
        this.cache.invalidateNamespace(
          CACHE_KEYS.orgMembersListNamespace(invitation.orgId),
        ),
        this.cache.invalidate(
          CACHE_KEYS.rbacDiscoveryMembers(invitation.orgId),
        ),
        this.cache.invalidate(
          CACHE_KEYS.moduleAccessCandidates(invitation.orgId),
        ),
        bustUsersStatsCache(this.cache, invitation.orgId),
        bustMembershipStatusCache(
          this.cache,
          existingUser.id,
          invitation.orgId,
        ),
      ]);

      return { ok: true, autoLoginToken };
    }

    const userId = randomUUID();
    const firstName = input.firstName?.trim() || null;
    const lastName = input.lastName?.trim() || null;
    const fromNames = [firstName, lastName].filter(Boolean).join(" ") || null;
    const emailLocal = invitation.email.split("@")[0]?.trim() || null;
    const fullName = fromNames ?? emailLocal;

    const autoLoginToken = randomBytes(32).toString("hex");
    try {
      await runInTenantTransaction(
        this.db,
        async (tx) => {
          const lockedInvitation = await this.lockPendingInvitation(
            tx,
            invitation.id,
            tokenHash,
          );
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${`quota:${invitation.orgId}:members`}, 0))`,
          );
          try {
            await this.planLimits.assertWithinLimit(
              invitation.orgId,
              "members",
              0,
              tx,
            );
          } catch (err) {
            if (err instanceof ForbiddenException) {
              throw new ForbiddenException(
                "This organization has reached its member limit. Ask an admin to upgrade the plan or free a seat.",
              );
            }
            throw err;
          }
          await tx.insert(users).values({
            id: userId,
            email: lockedInvitation.email,
            name: fullName,
            firstName,
            lastName,
            emailVerified: new Date(),
            lastActiveOrgId: lockedInvitation.orgId,
          });
          const inserted = await tx
            .insert(organizationMembers)
            .values({
              userId,
              orgId: lockedInvitation.orgId,
              role: lockedInvitation.role,
            })
            .onConflictDoNothing()
            .returning({ id: organizationMembers.id });
          const membershipId = inserted[0]?.id;
          if (membershipId === undefined) {
            throw new ConflictException(
              "You are already a member of this organization",
            );
          }
          await syncStructuralRoleAssignment(
            tx,
            lockedInvitation.orgId,
            membershipId,
            lockedInvitation.role,
          );

          const claimedRows = await tx
            .update(invitations)
            .set({
              acceptedAt: new Date(),
              status: "ACCEPTED",
              acceptedMembershipId: membershipId,
            })
            .where(
              and(
                eq(invitations.id, invitation.id),
                eq(invitations.status, "PENDING"),
                isNull(invitations.acceptedAt),
              ),
            )
            .returning({ id: invitations.id });
          if (claimedRows.length === 0)
            throw new NotFoundException("Invalid or expired invitation");
          await tx.insert(invitationEvents).values({
            orgId: invitation.orgId,
            invitationId: invitation.id,
            event: "ACCEPTED",
            actorMembershipId: membershipId,
          });
          await tx.insert(magicLinkTokens).values({
            id: randomUUID(),
            userId,
            tokenHash: createHash("sha256")
              .update(autoLoginToken)
              .digest("hex"),
            expiresAt: addMinutes(new Date(), 10),
          });
        },
        { orgId: invitedOrgId },
      );
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "23505") {
        throw new ConflictException("Invitation has already been accepted");
      }
      throw err;
    }
    await Promise.all([
      this.cache.invalidate(CACHE_KEYS.userSession(userId)),
      this.cache.invalidateNamespace(
        CACHE_KEYS.orgMembersListNamespace(invitation.orgId),
      ),
      this.cache.invalidate(CACHE_KEYS.rbacDiscoveryMembers(invitation.orgId)),
      this.cache.invalidate(
        CACHE_KEYS.moduleAccessCandidates(invitation.orgId),
      ),
      bustUsersStatsCache(this.cache, invitation.orgId),
      bustMembershipStatusCache(this.cache, userId, invitation.orgId),
    ]);

    return { ok: true, autoLoginToken };
  }

  async resend(
    orgId: string,
    invitationId: string,
    actorUserId: string,
  ): Promise<{ success: true }> {
    const org = await this.requireActiveOrg(orgId);

    const invitation = await this.db.query.invitations.findFirst({
      where: and(
        eq(invitations.id, invitationId),
        eq(invitations.orgId, orgId),
        isNull(invitations.acceptedAt),
      ),
    });
    if (!invitation)
      throw new NotFoundException("Invitation not found or already accepted");

    const rawToken = randomBytes(32).toString("hex");
    const newExpiresAt = addDays(new Date(), 7);

    const actorMembership = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, actorUserId),
      ),
      columns: { id: true },
    });

    await runInTenantTransaction(
      this.db,
      async (tx) => {
        const updated = await tx
          .update(invitations)
          .set({
            tokenHash: hashToken(rawToken),
            expiresAt: newExpiresAt,
            status: "PENDING",
            revokedAt: null,
            revokedByMembershipId: null,
            declinedAt: null,
          })
          .where(
            and(
              eq(invitations.id, invitationId),
              eq(invitations.orgId, orgId),
              eq(invitations.status, invitation.status),
              isNull(invitations.acceptedAt),
            ),
          )
          .returning({ id: invitations.id });
        if (updated.length === 0) {
          throw new NotFoundException("Invitation not found or already accepted");
        }
        await tx.insert(invitationEvents).values({
          orgId,
          invitationId,
          event: "RESENT",
          actorMembershipId: actorMembership?.id ?? null,
        });
      },
      { orgId },
    );

    const inviter = await this.db.query.users.findFirst({
      where: eq(users.id, actorUserId),
      columns: { name: true, firstName: true, lastName: true },
    });

    const inviterName =
      inviter?.firstName && inviter?.lastName
        ? `${inviter.firstName} ${inviter.lastName}`
        : (inviter?.name ?? undefined);

    void this.email
      .sendInvitationEmail(invitation.email, rawToken, org.name, inviterName)
      .catch((err: unknown) =>
        this.recordDeliveryFailure(orgId, invitationId, err),
      );

    this.audit.log({
      action: "user.invitation.resent",
      userId: actorUserId,
      orgId,
      targetId: invitationId,
      targetType: "invitation",
      metadata: { email: invitation.email },
    });

    await bustUsersStatsCache(this.cache, orgId);
    return { success: true };
  }

  /** Changes the structural role a PENDING invitation will grant. */
  async changeRole(
    orgId: string,
    invitationId: string,
    actor: InviteActor,
    role: string,
  ): Promise<{ success: true }> {
    await this.assertMayInviteWithRole(orgId, actor, role);

    const invitation = await this.db.query.invitations.findFirst({
      where: and(
        eq(invitations.id, invitationId),
        eq(invitations.orgId, orgId),
        inArray(invitations.status, ["PENDING", "EXPIRED"]),
        isNull(invitations.acceptedAt),
      ),
    });
    if (!invitation) {
      throw new NotFoundException("Invitation not found or already accepted");
    }
    if (invitation.role === role) return { success: true };

    const actorMembership = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, actor.userId),
      ),
      columns: { id: true },
    });

    await runInTenantTransaction(
      this.db,
      async (tx) => {
        const updated = await tx
          .update(invitations)
          .set({ role })
          .where(
            and(
              eq(invitations.id, invitationId),
              eq(invitations.orgId, orgId),
              eq(invitations.status, invitation.status),
              eq(invitations.role, invitation.role),
              isNull(invitations.acceptedAt),
            ),
          )
          .returning({ id: invitations.id });
        if (updated.length === 0) {
          throw new NotFoundException("Invitation not found or already accepted");
        }
        await tx.insert(invitationEvents).values({
          orgId,
          invitationId,
          event: "ROLE_CHANGED",
          actorMembershipId: actorMembership?.id ?? null,
        });
      },
      { orgId },
    );

    this.audit.log({
      action: "user.invitation.role_changed",
      userId: actor.userId,
      orgId,
      targetId: invitationId,
      targetType: "invitation",
      metadata: { from: invitation.role, to: role },
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
        inArray(invitations.status, ["PENDING", "EXPIRED"]),
        isNull(invitations.acceptedAt),
      ),
    });
    if (!invitation)
      throw new NotFoundException("Invitation not found or already accepted");

    const actorMembership = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, actorUserId),
      ),
      columns: { id: true },
    });

    await runInTenantTransaction(
      this.db,
      async (tx) => {
        const updated = await tx
          .update(invitations)
          .set({
            status: "REVOKED",
            revokedAt: new Date(),
            revokedByMembershipId: actorMembership?.id ?? null,
          })
          .where(
            and(
              eq(invitations.id, invitationId),
              eq(invitations.orgId, orgId),
              eq(invitations.status, invitation.status),
              isNull(invitations.acceptedAt),
            ),
          )
          .returning({ id: invitations.id });
        if (updated.length === 0) {
          throw new NotFoundException("Invitation not found or already accepted");
        }
        await tx.insert(invitationEvents).values({
          orgId,
          invitationId,
          event: "REVOKED",
          actorMembershipId: actorMembership?.id ?? null,
        });
      },
      { orgId },
    );

    this.audit.log({
      action: "user.invitation.cancelled",
      userId: actorUserId,
      orgId,
      targetId: invitationId,
      targetType: "invitation",
      metadata: { email: invitation.email },
    });

    await bustUsersStatsCache(this.cache, orgId);
    return { success: true };
  }

  async expireStaleInvitations(): Promise<{ expired: number }> {
    const now = new Date();
    const updated = await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(invitations)
        .set({ status: "EXPIRED" })
        .where(
          and(
            eq(invitations.status, "PENDING"),
            lt(invitations.expiresAt, now),
          ),
        )
        .returning({ id: invitations.id, orgId: invitations.orgId });
      if (rows.length > 0) {
        await tx.insert(invitationEvents).values(
          rows.map((r) => ({
            orgId: r.orgId,
            invitationId: r.id,
            event: "EXPIRED" as const,
            actorMembershipId: null,
          })),
        );
      }
      return rows;
    });
    const orgIds = [...new Set(updated.map((r) => r.orgId))];
    await Promise.all(
      orgIds.map((orgId) => bustUsersStatsCache(this.cache, orgId)),
    );
    return { expired: updated.length };
  }
}
