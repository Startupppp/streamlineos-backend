import { Injectable, Logger } from "@nestjs/common";
import { importJWK, exportJWK, SignJWT, jwtVerify, type JWTPayload, type JWK } from "jose";
import { randomUUID } from "node:crypto";
import { INTERNAL_TOKEN_AUDIENCE, INTERNAL_TOKEN_ISSUER, type BackendClaims } from "./backend-claims";

interface SerializedKeyEntry {
  kid: string;
  privateKey: JWK;
  publicKey: JWK;
}

interface KeyEntry {
  kid: string;
  privateKey: Awaited<ReturnType<typeof importJWK>>;
  publicKey: Awaited<ReturnType<typeof importJWK>>;
  publicJwk: JWK;
}

const TOKEN_TTL = "10m";
const TOKEN_CLOCK_SKEW_SECS = 30;

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

    let entries: SerializedKeyEntry[];
    try {
      entries = JSON.parse(raw) as SerializedKeyEntry[];
    } catch {
      throw new Error("AUTH_SIGNING_KEYS must be a valid JSON array of {kid, privateKey, publicKey}");
    }

    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error("AUTH_SIGNING_KEYS must contain at least one key entry");
    }

    for (const entry of entries) {
      if (!entry.kid || !entry.privateKey || !entry.publicKey) {
        throw new Error("Each AUTH_SIGNING_KEYS entry must have kid, privateKey, and publicKey");
      }
      const privateKey = await importJWK(entry.privateKey, "EdDSA");
      const publicKey = await importJWK(entry.publicKey, "EdDSA");
      const rawPublicJwk = await exportJWK(publicKey);
      const publicJwk: JWK = {
        ...rawPublicJwk,
        kid: entry.kid,
        alg: "EdDSA",
        use: "sig",
      };
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

  async verifyToken(token: string): Promise<(JWTPayload & { sub: string; sessionId: string; orgId: string | null }) | null> {
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
        return { ...payload, sub, sessionId, orgId };
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
