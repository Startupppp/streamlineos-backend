import { Injectable } from "@nestjs/common";
import { SignJWT } from "jose";
import { PORTAL_AUDIENCE } from "../../../common/portal-auth/portal-claims";

const EXPIRY_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface MintInput {
  portalMembershipId: string;
  organizationId: string;
  partyContactId: string;
  sessionEpoch: number;
  userId: string | null;
}

export interface MintedToken {
  token: string;
  expiresAt: Date;
}

@Injectable()
export class PortalTokenService {
  private readonly secretKey: Uint8Array;

  constructor() {
    const raw = process.env.PORTAL_JWT_SECRET;
    if (!raw) throw new Error("PORTAL_JWT_SECRET is required");
    this.secretKey = new TextEncoder().encode(raw);
  }

  async mint(input: MintInput): Promise<MintedToken> {
    const expiresAt = new Date(Date.now() + EXPIRY_DAYS * MS_PER_DAY);

    const token = await new SignJWT({
      orgId: input.organizationId,
      partyContactId: input.partyContactId,
      sessionEpoch: input.sessionEpoch,
      audience: PORTAL_AUDIENCE,
      userId: input.userId,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(input.portalMembershipId)
      .setAudience(PORTAL_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(expiresAt)
      .sign(this.secretKey);

    return { token, expiresAt };
  }
}
