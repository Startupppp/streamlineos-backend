import { importJWK, SignJWT, type JWK } from "jose";
import { randomUUID } from "node:crypto";
import {
  INTERNAL_TOKEN_AUDIENCE,
  INTERNAL_TOKEN_ISSUER,
  type BackendClaims,
} from "src/common/auth/backend-claims";
import { moduleIds } from "src/common/rbac/module-registry";

/**
 * EVERY module, not just the plan-gated ones. A permission-tier test has to get past
 * the module tier first — `authorize` answers NO_MODULE before it reads a single grant —
 * so a token missing a module proves 402, never the 403 the test is named for. This read
 * MODULE_CATALOG until that constant became money-only, at which point chat and kb fell
 * out of it and seven chat specs started failing on 402.
 */
export const ALL_MODULES: string[] = moduleIds();

type IgnoredClaims = {
  branchId?: string | null;
  role?: string;
  permissions?: string[];
  enabledModules?: string[];
  plan?: string | null;
  isOrgOwner?: boolean;
};

interface SerializedKeyEntry {
  kid: string;
  privateKey: JWK;
  publicKey: JWK;
}

export async function signToken(
  claims: Partial<BackendClaims> & IgnoredClaims = {},
): Promise<string> {
  const payload: BackendClaims = {
    sub: claims.sub ?? "user_1",
    orgId: claims.orgId ?? "org_1",
    sessionId: claims.sessionId ?? "sess_1",
  };

  const raw = process.env.AUTH_SIGNING_KEYS?.trim();
  if (!raw) {
    throw new Error(
      "AUTH_SIGNING_KEYS must be set for e2e tests — the guard no longer accepts HS256",
    );
  }

  let entries: SerializedKeyEntry[];
  try {
    entries = JSON.parse(raw) as SerializedKeyEntry[];
  } catch {
    throw new Error("AUTH_SIGNING_KEYS must be a valid JSON array");
  }

  const latest = entries[entries.length - 1];
  if (!latest) throw new Error("AUTH_SIGNING_KEYS contains no keys");

  const privateKey = await importJWK(latest.privateKey, "EdDSA");

  return new SignJWT({
    ...payload,
    ...(claims.role !== undefined ? { role: claims.role } : {}),
    ...(claims.permissions !== undefined ? { permissions: claims.permissions } : {}),
    ...(claims.enabledModules !== undefined ? { enabledModules: claims.enabledModules } : {}),
    ...(claims.isOrgOwner !== undefined ? { isOrgOwner: claims.isOrgOwner } : {}),
  })
    .setProtectedHeader({ alg: "EdDSA", kid: latest.kid })
    .setIssuer(INTERNAL_TOKEN_ISSUER)
    .setAudience(INTERNAL_TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("10m")
    .setJti(randomUUID())
    .sign(privateKey);
}
