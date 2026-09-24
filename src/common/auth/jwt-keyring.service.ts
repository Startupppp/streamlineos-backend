import { Injectable, Logger } from "@nestjs/common";
import { importJWK, exportJWK, SignJWT, jwtVerify, type JWTPayload, type JWK } from "jose";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { INTERNAL_TOKEN_AUDIENCE, INTERNAL_TOKEN_ISSUER, type BackendClaims, type ImpersonationClaims } from "./backend-claims";

const impersonationClaimsSchema = z.object({
  realActorUserId: z.string(),
  realSessionId: z.string(),
  impersonationSessionId: z.string(),
});

const jwkSchema = z.custom<JWK>((v: unknown) => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  if (!("kty" in v)) return false;
  return typeof v.kty === "string";
});

const signingKeyEntrySchema = z.object({
  kid: z.string().min(1),
  privateKey: jwkSchema,
  publicKey: jwkSchema,
});
const signingKeysSchema = z.array(signingKeyEntrySchema).min(1);

interface KeyEntry {
  kid: string;
  privateKey: Awaited<ReturnType<typeof importJWK>>;
  publicKey: Awaited<ReturnType<typeof importJWK>>;
  publicJwk: JWK;
}

const TOKEN_TTL = "10m";
const IMPERSONATION_TOKEN_TTL = "30m";
const TOKEN_CLOCK_SKEW_SECS = 30;

/**
 * `/auth/.well-known/jwks.json` is `@Public()`, so whatever `publicJwk` holds is
 * served to the internet. `importJWK` accepts a private JWK just as readily as a
 * public one, and `exportJWK` then round-trips `d` straight back out — so an
 * entry whose `publicKey` slot was filled with the private half published the
 * Ed25519 seed and let anyone forge a token for any user. Project instead of
 * spreading: only these members ever reach the document.
 */
const PUBLIC_JWK_MEMBERS = ["crv", "x", "y", "n", "e"] as const;
const PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "k"] as const;

function toPublicJwk(jwk: JWK, kid: string): JWK {
  const projected: JWK = { kty: jwk.kty, kid, alg: "EdDSA", use: "sig" };
  for (const member of PUBLIC_JWK_MEMBERS) {
    const value = jwk[member];
    if (value !== undefined) projected[member] = value;
  }
  return projected;
}

function carriesPrivateMaterial(jwk: JWK): boolean {
  return PRIVATE_JWK_MEMBERS.some((member) => jwk[member] !== undefined);
}

@Injectable()
export class JwtKeyringService {
  private readonly logger = new Logger(JwtKeyringService.name);
  private keys: KeyEntry[] = [];
  private initialized = false;

  async onModuleInit(): Promise<void> {
    await this.loadKeys();
    this.initialized = true;
  }

  private async loadKeys(): Promise<void> {
    const raw = process.env.AUTH_SIGNING_KEYS?.trim();
    if (!raw) {
      this.logger.error(
        "AUTH_SIGNING_KEYS is not set — asymmetric JWT signing is unavailable",
      );
      return;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      throw new Error("AUTH_SIGNING_KEYS must be a valid JSON array of {kid, privateKey, publicKey}");
    }

    const keysResult = signingKeysSchema.safeParse(parsedJson);
    if (!keysResult.success) {
      throw new Error("AUTH_SIGNING_KEYS must be a valid JSON array of {kid, privateKey, publicKey}");
    }

    for (const entry of keysResult.data) {
      if (carriesPrivateMaterial(entry.publicKey)) {
        this.logger.error(
          `AUTH_SIGNING_KEYS entry "${entry.kid}" has private key material in its publicKey slot. ` +
            "It is being stripped before publication, but treat that key as compromised and rotate it.",
        );
      }
      const privateKey = await importJWK(entry.privateKey, "EdDSA");
      const publicKey = await importJWK(entry.publicKey, "EdDSA");
      const publicJwk = toPublicJwk(await exportJWK(publicKey), entry.kid);
      this.keys.push({ kid: entry.kid, privateKey, publicKey, publicJwk });
    }

    this.logger.log(`Loaded ${this.keys.length} signing key(s)`);
  }

  isReady(): boolean {
    return this.initialized && this.keys.length > 0;
  }

  async signToken(claims: BackendClaims): Promise<string> {
    if (!this.isReady()) {
      throw new Error("JWT keyring has no keys loaded");
    }
    const current = this.keys[this.keys.length - 1];
    return new SignJWT({ orgId: claims.orgId ?? null, sessionId: claims.sessionId })
      .setProtectedHeader({ alg: "EdDSA", kid: current.kid })
      .setSubject(claims.sub)
      .setIssuer(INTERNAL_TOKEN_ISSUER)
      .setAudience(INTERNAL_TOKEN_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(TOKEN_TTL)
      .setJti(randomUUID())
      .sign(current.privateKey);
  }

  async signImpersonationToken(claims: BackendClaims & { impersonation: ImpersonationClaims }): Promise<string> {
    if (!this.isReady()) {
      throw new Error("JWT keyring has no keys loaded");
    }
    const current = this.keys[this.keys.length - 1];
    return new SignJWT({
      orgId: claims.orgId ?? null,
      sessionId: claims.sessionId,
      impersonation: claims.impersonation,
    })
      .setProtectedHeader({ alg: "EdDSA", kid: current.kid })
      .setSubject(claims.sub)
      .setIssuer(INTERNAL_TOKEN_ISSUER)
      .setAudience(INTERNAL_TOKEN_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(IMPERSONATION_TOKEN_TTL)
      .setJti(randomUUID())
      .sign(current.privateKey);
  }

  async verifyToken(
    token: string,
  ): Promise<(JWTPayload & { sub: string; sessionId: string; orgId: string | null; impersonation?: ImpersonationClaims }) | null> {
    if (!this.initialized) return null;

    for (const key of this.keys) {
      try {
        const { payload } = await jwtVerify(token, key.publicKey, {
          algorithms: ["EdDSA"],
          audience: INTERNAL_TOKEN_AUDIENCE,
          issuer: INTERNAL_TOKEN_ISSUER,
          clockTolerance: TOKEN_CLOCK_SKEW_SECS,
        });
        const sub = payload.sub;
        const sessionId = typeof payload["sessionId"] === "string" ? payload["sessionId"] : null;
        const rawOrgId = payload["orgId"];
        const orgId = typeof rawOrgId === "string" && rawOrgId.length > 0 ? rawOrgId : null;
        if (!sub || !sessionId) return null;
        const rawImpersonation = payload["impersonation"];
        const impersonationResult = impersonationClaimsSchema.safeParse(rawImpersonation);
        const impersonation: ImpersonationClaims | undefined = impersonationResult.success
          ? impersonationResult.data
          : undefined;
        return { ...payload, sub, sessionId, orgId, impersonation };
      } catch {
        // Try next key — handles wrong-kid or expiry per-key
      }
    }
    return null;
  }

  getJwks(): { keys: JWK[] } {
    return { keys: this.keys.map((k) => k.publicJwk) };
  }
}
