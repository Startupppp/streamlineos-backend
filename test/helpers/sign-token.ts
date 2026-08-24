import { SignJWT } from "jose";
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

export async function signToken(
  claims: Partial<BackendClaims> & IgnoredClaims = {},
  secret = process.env.BACKEND_JWT_SECRET ?? "x".repeat(44),
): Promise<string> {
  const payload: BackendClaims = {
    sub: claims.sub ?? "user_1",
    orgId: claims.orgId ?? "org_1",
    sessionId: claims.sessionId ?? "sess_1",
  };
  // The guards resolve role, permissions and modules from the database, not the
  // token — but the e2e harness stubs those services and reads its fixture back
  // out of these claims, so they have to survive signing.
  return new SignJWT({
    ...payload,
    ...(claims.role !== undefined ? { role: claims.role } : {}),
    ...(claims.permissions !== undefined ? { permissions: claims.permissions } : {}),
    ...(claims.enabledModules !== undefined ? { enabledModules: claims.enabledModules } : {}),
    ...(claims.isOrgOwner !== undefined ? { isOrgOwner: claims.isOrgOwner } : {}),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(INTERNAL_TOKEN_ISSUER)
    .setAudience(INTERNAL_TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(secret));
}
