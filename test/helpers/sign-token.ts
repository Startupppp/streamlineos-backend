import { SignJWT } from "jose";
import {
  INTERNAL_TOKEN_AUDIENCE,
  INTERNAL_TOKEN_ISSUER,
  type BackendClaims,
} from "src/common/auth/backend-claims";

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
