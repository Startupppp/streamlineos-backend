import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { portalInvitations, portalMemberships } from "../../../db/schema";
import { hashToken } from "../../../common/security/token.util";
import { withPublicToken } from "../../../common/tenant/with-public-token";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { PortalTokenService, type MintedToken } from "./portal-token.service";

const GENERIC_REJECTION = "Invalid or expired invitation token";

@Injectable()
export class PortalAuthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly tokens: PortalTokenService,
  ) {}

  async acceptInvitation(rawToken: string): Promise<MintedToken> {
    const tokenHash = hashToken(rawToken);
    const now = new Date();

    const invitation = await withPublicToken(this.db, tokenHash, (tx) =>
      tx.query.portalInvitations.findFirst({
        where: and(
          eq(portalInvitations.tokenHash, tokenHash),
          eq(portalInvitations.status, "PENDING"),
          gt(portalInvitations.expiresAt, now),
        ),
      }),
    );
    if (!invitation) throw new UnauthorizedException(GENERIC_REJECTION);

    try {
      return await runInTenantTransaction(
        this.db,
        async (tx) => {
          const [existing] = await tx
            .select()
            .from(portalMemberships)
            .where(
              and(
                eq(portalMemberships.organizationId, invitation.organizationId),
                eq(portalMemberships.partyContactId, invitation.partyContactId),
                eq(portalMemberships.audience, invitation.audience),
                ne(portalMemberships.status, "REVOKED"),
                isNull(portalMemberships.deletedAt),
              ),
            )
            .limit(1);

          if (existing?.status === "SUSPENDED") {
            throw new UnauthorizedException(GENERIC_REJECTION);
          }

          let membershipId: string;
          let sessionEpoch: number;

          if (existing) {
            const [updated] = await tx
              .update(portalMemberships)
              .set({
                status: "ACTIVE",
                sessionEpoch: sql`${portalMemberships.sessionEpoch} + 1`,
              })
              .where(
                and(
                  eq(portalMemberships.portalMembershipId, existing.portalMembershipId),
                  eq(portalMemberships.organizationId, existing.organizationId),
                ),
              )
              .returning({
                portalMembershipId: portalMemberships.portalMembershipId,
                sessionEpoch: portalMemberships.sessionEpoch,
              });

            if (!updated) throw new UnauthorizedException(GENERIC_REJECTION);
            membershipId = updated.portalMembershipId;
            sessionEpoch = updated.sessionEpoch;
          } else {
            const [created] = await tx
              .insert(portalMemberships)
              .values({
                organizationId: invitation.organizationId,
                audience: invitation.audience,
                partyContactId: invitation.partyContactId,
                userId: null,
                status: "ACTIVE",
                sessionEpoch: 0,
              })
              .returning({
                portalMembershipId: portalMemberships.portalMembershipId,
                sessionEpoch: portalMemberships.sessionEpoch,
              });

            if (!created) throw new UnauthorizedException(GENERIC_REJECTION);
            membershipId = created.portalMembershipId;
            sessionEpoch = created.sessionEpoch;
          }

          await tx
            .update(portalInvitations)
            .set({
              status: "ACCEPTED",
              acceptedPortalMembershipId: membershipId,
            })
            .where(
              and(
                eq(portalInvitations.portalInvitationId, invitation.portalInvitationId),
                eq(portalInvitations.organizationId, invitation.organizationId),
              ),
            );

          return this.tokens.mint({
            portalMembershipId: membershipId,
            organizationId: invitation.organizationId,
            partyContactId: invitation.partyContactId,
            sessionEpoch,
            userId: null,
          });
        },
        { orgId: invitation.organizationId, audience: "PORTAL" },
      );
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException(GENERIC_REJECTION);
    }
  }
}
