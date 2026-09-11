import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, gt, ilike, isNull, lt, sql } from "drizzle-orm";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetBefore } from "../../../common/pagination/keyset";
import { hashToken } from "../../../common/security/token.util";
import { withPublicToken } from "../../../common/tenant/with-public-token";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { invitationEvents, invitations, users } from "../../../db/schema";
import { expiredByTimePredicate, requireActiveOrg } from "./invitations.helpers";

export interface ListInvitationsParams {
  /** Retained while the users route is migrated to pass `cursor`. */
  page?: number;
  cursor?: string;
  limit?: number;
  includeAccepted?: boolean;
  status?: "pending" | "accepted" | "expired" | "revoked";
  q?: string;
}

type InvitationCursorScope = {
  orgId: string;
  includeAccepted: boolean;
  status: ListInvitationsParams["status"] | null;
  q: string | null;
};

function invalidInvitationCursor(): never {
  throw new BadRequestException("Invalid pagination cursor");
}

function decodeInvitationCursor(
  value: string | undefined,
  expected: InvitationCursorScope,
) {
  if (!value) return null;

  const position = decodeCursor(value);
  if (!position || Number.isNaN(new Date(position.sortValue).getTime())) {
    return invalidInvitationCursor();
  }

  try {
    const scope: unknown = JSON.parse(position.id);
    if (
      !Array.isArray(scope) ||
      scope.length !== 5 ||
      scope[0] !== expected.orgId ||
      scope[1] !== expected.includeAccepted ||
      scope[2] !== expected.status ||
      scope[3] !== expected.q ||
      typeof scope[4] !== "string" ||
      scope[4].length === 0
    ) {
      return invalidInvitationCursor();
    }
    return { sortValue: position.sortValue, id: scope[4] };
  } catch {
    return invalidInvitationCursor();
  }
}

@Injectable()
export class InvitationsReadService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listPaginated(orgId: string, params?: ListInvitationsParams) {
    const limit = Math.min(params?.limit ?? 20, 100);
    const now = new Date();
    const q = params?.q?.trim() || null;
    const cursorScope: InvitationCursorScope = {
      orgId,
      includeAccepted: params?.includeAccepted === true,
      status: params?.status ?? null,
      q,
    };
    const cursor = decodeInvitationCursor(params?.cursor, cursorScope);

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

    if (q) {
      const escaped = q.replace(/[%_\\]/g, (m) => `\\${m}`);
      conditions.push(ilike(invitations.email, `${escaped}%`));
    }
    if (cursor) {
      conditions.push(keysetBefore(invitations.createdAt, invitations.id, cursor));
    }

    const data = await this.db
      .select({
        id: invitations.id,
        email: invitations.email,
        role: invitations.role,
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
      .orderBy(desc(invitations.createdAt), desc(invitations.id))
      .limit(limit + 1);

    return buildCursorPage(data, limit, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: JSON.stringify([
        cursorScope.orgId,
        cursorScope.includeAccepted,
        cursorScope.status,
        cursorScope.q,
        row.id,
      ]),
    }));
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
