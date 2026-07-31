import { SignJWT } from "jose";
import type { BackendClaims } from "src/common/auth/backend-claims";

export async function signToken(
  claims: Partial<BackendClaims> = {},
  secret = process.env.BACKEND_JWT_SECRET ?? "x".repeat(44),
): Promise<string> {
  const payload: BackendClaims = {
    sub: "user_1",
    orgId: "org_1",
    branchId: null,
    role: "SALES",
    permissions: ["crm:leads:read"],
    enabledModules: ["crm"],
    plan: "PROFESSIONAL",
    isOrgOwner: false,
    sessionId: "sess_1",
    ...claims,
  };
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(secret));
}
