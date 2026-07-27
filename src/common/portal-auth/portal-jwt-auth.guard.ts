import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { jwtVerify } from "jose";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { portalMemberships } from "../../db/schema";
import { PORTAL_AUDIENCE, type PortalUserContext } from "./portal-claims";
import { portalJwtPayloadSchema } from "./portal-claims-schema";

type PortalRequest = Request & { portalUser?: PortalUserContext };

@Injectable()
export class PortalJwtAuthGuard implements CanActivate {
  private readonly portalSecretKey: Uint8Array | null;

  constructor(@Inject(DRIZZLE) private readonly db: Db) {
    const raw = process.env.PORTAL_JWT_SECRET;
    this.portalSecretKey = raw ? new TextEncoder().encode(raw) : null;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<PortalRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Unauthorized");
    }
    const token = header.slice("Bearer ".length).trim();

    if (!this.portalSecretKey) {
      throw new UnauthorizedException("Unauthorized");
    }

    try {
      const { payload } = await jwtVerify(token, this.portalSecretKey, {
        algorithms: ["HS256"],
        audience: PORTAL_AUDIENCE,
      });

      if (payload.aud !== PORTAL_AUDIENCE) {
        throw new UnauthorizedException("Unauthorized");
      }

      const parseResult = portalJwtPayloadSchema.safeParse(payload);
      if (!parseResult.success) {
        throw new UnauthorizedException("Unauthorized");
      }

      const parsed = parseResult.data;

      const rows = await this.db
        .select({
          partyContactId: portalMemberships.partyContactId,
          status: portalMemberships.status,
          sessionEpoch: portalMemberships.sessionEpoch,
          userId: portalMemberships.userId,
        })
        .from(portalMemberships)
        .where(
          and(
            eq(portalMemberships.portalMembershipId, parsed.sub),
            eq(portalMemberships.organizationId, parsed.orgId),
          ),
        )
        .limit(1);

      const membership = rows[0];
      if (!membership) {
        throw new UnauthorizedException("Unauthorized");
      }

      if (membership.status !== "ACTIVE") {
        throw new UnauthorizedException("Unauthorized");
      }

      if (membership.sessionEpoch !== parsed.sessionEpoch) {
        throw new UnauthorizedException("Unauthorized");
      }

      req.portalUser = {
        portalMembershipId: parsed.sub,
        organizationId: parsed.orgId,
        partyContactId: membership.partyContactId,
        audience: PORTAL_AUDIENCE,
        sessionEpoch: parsed.sessionEpoch,
        userId: membership.userId,
      };

      return true;
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException("Unauthorized");
    }
  }
}
