import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID, createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { addMinutes } from "date-fns";
import { withIdentity } from "../../../../common/tenant/with-identity";
import { LEGACY_CELL_ID } from "../../../../common/region/placement";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { type Db } from "../../../../db/drizzle.module";
import { syncStructuralRoleAssignment } from "../../../../common/rbac/sync-structural-role";
import type { PlanLimitsService } from "../../../billing/core/plan-limits.service";
import type { SeatLedgerService } from "../../../billing/core/seat-ledger.service";
import {
  accountOrganizationIndex,
  invitationEvents,
  invitations,
  magicLinkTokens,
  organizationMembers,
  organizations,
  users,
} from "../../../../db/schema";
import type { DbOrTx } from "../../../../common/rbac/access-invalidate";
import type { AcceptInvitationInput } from "../dto/organization.schemas";
import { lockPendingInvitation } from "../invitations.helpers";

/**
 * Everything acceptance WRITES, once the token has already been judged.
 *
 * InvitationAcceptanceService keeps the deciding half: it hashes an untrusted
 * token, resolves it through withPublicToken, tells an archived or suspended
 * membership apart from an already-joined one, declines, and fans out the
 * best-effort admin notifications allowed to fail. Nothing here is reachable
 * without that gate, so these take the invitation and org ids as given and only
 * commit the join. Both accept paths re-lock the invitation inside their own
 * transaction rather than trusting the row the caller read outside it, and both
 * take the per-org member quota advisory lock first, so the seat check is a
 * serialized write invariant. touchIndexLastActivated is the exception:
 * account_organization_index is the global cross-org index, so it runs under
 * withIdentity outside that transaction, fired best-effort after the commit.
 */
export interface InvitationJoinDeps {
  readonly db: Db;
  readonly planLimits: PlanLimitsService;
  readonly seatLedger: SeatLedgerService;
}

export async function touchIndexLastActivated(
  deps: InvitationJoinDeps,
  orgId: string,
  userId: string,
): Promise<void> {
  const [org, membership] = await Promise.all([
    deps.db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
      columns: { name: true, slug: true, region: true, status: true },
    }),
    deps.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.orgId, orgId),
      ),
      columns: { role: true, status: true, joinedAt: true },
    }),
  ]);
  if (!org || !membership) return;
  await withIdentity(deps.db, userId, (tx) =>
    tx
      .insert(accountOrganizationIndex)
      .values({
        userId,
        orgId,
        cellId: LEGACY_CELL_ID,
        region: org.region ?? "primary",
        organizationName: org.name,
        organizationSlug: org.slug,
        membershipRole: membership.role,
        membershipStatus: membership.status,
        organizationStatus: org.status,
        joinedAt: membership.joinedAt,
        lastActivatedAt: new Date(),
        projectedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [accountOrganizationIndex.userId, accountOrganizationIndex.orgId],
        set: {
          membershipRole: sql`excluded.membership_role`,
          membershipStatus: sql`excluded.membership_status`,
          organizationStatus: sql`excluded.organization_status`,
          joinedAt: sql`excluded.joined_at`,
          lastActivatedAt: sql`excluded.last_activated_at`,
          projectedAt: sql`excluded.projected_at`,
        },
      }),
  );
}

async function assertSeatAvailable(
  deps: InvitationJoinDeps,
  tx: DbOrTx,
  orgId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`quota:${orgId}:members`}, 0))`,
  );
  try {
    await deps.planLimits.assertWithinLimit(orgId, "members", 0, tx);
  } catch (err) {
    if (err instanceof ForbiddenException) {
      throw new ForbiddenException(
        "This organization has reached its member limit. Ask an admin to upgrade the plan or free a seat.",
      );
    }
    throw err;
  }
}

async function claimInvitation(
  deps: InvitationJoinDeps,
  tx: DbOrTx,
  invitationId: string,
  orgId: string,
  membershipId: number,
): Promise<void> {
  const claimedRows = await tx
    .update(invitations)
    .set({
      acceptedAt: new Date(),
      status: "ACCEPTED",
      acceptedMembershipId: membershipId,
    })
    .where(
      and(
        eq(invitations.id, invitationId),
        eq(invitations.status, "PENDING"),
        isNull(invitations.acceptedAt),
      ),
    )
    .returning({ id: invitations.id });
  if (claimedRows.length === 0)
    throw new NotFoundException("Invalid or expired invitation");
  await tx.insert(invitationEvents).values({
    orgId,
    invitationId,
    event: "ACCEPTED",
    actorMembershipId: membershipId,
  });
  await deps.seatLedger.recordSeatEvent(
    {
      orgId,
      eventType: "INVITE_ACCEPTED",
      subjectId: invitationId,
      reason: "invitation accepted",
      idempotencyKey: `invite-accepted:${invitationId}`,
    },
    tx,
  );
}

function issueMagicLink(
  tx: DbOrTx,
  userId: string,
  rawToken: string,
): Promise<unknown> {
  return tx.insert(magicLinkTokens).values({
    id: randomUUID(),
    userId,
    tokenHash: createHash("sha256").update(rawToken).digest("hex"),
    expiresAt: addMinutes(new Date(), 10),
  });
}

export async function acceptAsExistingUser(
  deps: InvitationJoinDeps,
  invitationId: string,
  orgId: string,
  tokenHash: string,
  userId: string,
  autoLoginToken: string,
): Promise<string> {
  await runInTenantTransaction(
    deps.db,
    async (tx) => {
      const lockedInvitation = await lockPendingInvitation(
        tx,
        invitationId,
        tokenHash,
      );
      await assertSeatAvailable(deps, tx, orgId);

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

      await tx
        .update(users)
        .set({ lastActiveOrgId: lockedInvitation.orgId })
        .where(eq(users.id, userId));

      await claimInvitation(deps, tx, invitationId, orgId, membershipId);
      await issueMagicLink(tx, userId, autoLoginToken);
    },
    { orgId },
  );
  return userId;
}

export async function acceptAsNewUser(
  deps: InvitationJoinDeps,
  invitationId: string,
  orgId: string,
  tokenHash: string,
  input: AcceptInvitationInput,
  autoLoginToken: string,
): Promise<string> {
  const userId = randomUUID();
  const firstName = input.firstName?.trim() || null;
  const lastName = input.lastName?.trim() || null;

  try {
    await runInTenantTransaction(
      deps.db,
      async (tx) => {
        const lockedInvitation = await lockPendingInvitation(
          tx,
          invitationId,
          tokenHash,
        );
        await assertSeatAvailable(deps, tx, orgId);

        const fromNames =
          [firstName, lastName].filter(Boolean).join(" ") || null;
        const emailLocal =
          lockedInvitation.email.split("@")[0]?.trim() || null;

        await tx.insert(users).values({
          id: userId,
          email: lockedInvitation.email,
          name: fromNames ?? emailLocal,
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

        await claimInvitation(deps, tx, invitationId, orgId, membershipId);
        await issueMagicLink(tx, userId, autoLoginToken);
      },
      { orgId },
    );
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "23505") {
      throw new ConflictException("Invitation has already been accepted");
    }
    throw err;
  }
  return userId;
}
