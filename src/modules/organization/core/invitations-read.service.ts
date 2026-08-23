import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, gt, ilike, isNull, lt, sql } from "drizzle-orm";
import { hashToken } from "../../../common/security/token.util";
import { withPublicToken } from "../../../common/tenant/with-public-token";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { invitationEvents, invitations, users } from "../../../db/schema";
import { expiredByTimePredicate, requireActiveOrg } from "./invitations.helpers";

export interface ListInvitationsParams {
  page?: number;
  limit?: number;
  includeAccepted?: boolean;
  status?: "pending" | "accepted" | "expired" | "revoked";
  q?: string;
}

@Injectable()
export class InvitationsReadService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listPaginated(orgId: string, params?: ListInvitationsParams) {
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
      const expiredFilter = expiredByTimePredicate(now);
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
          declinedAt: invitations.declinedAt,
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
    const tokenHash = hashToken(token);
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

    const { org, existingUser } = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const [org, existingUser] = await Promise.all([
          requireActiveOrg(tx, invitation.orgId),
          tx.query.users.findFirst({
            where: eq(users.email, invitation.email),
            columns: { id: true },
          }),
        ]);
        return { org, existingUser };
      },
      { orgId: invitation.orgId },
    );

    return {
      email: invitation.email,
      organizationName: org.name,
      role: invitation.role,
      userExists: !!existingUser,
    };
  }
}
