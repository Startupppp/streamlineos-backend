import type { Principal } from "./principal";

export const INTERNAL_TOKEN_AUDIENCE = "streamlineos-api" as const;
export const INTERNAL_TOKEN_ISSUER = "streamlineos-web" as const;

export const SESSION_PROOF_ISSUER = "streamlineos-web-session-proof" as const;
export const SESSION_PROOF_AUDIENCE = "streamlineos-api-exchange" as const;

export interface BackendClaims {
  sub: string;
  orgId: string | null;
  sessionId: string;
}

export interface CurrentUserContext {
  userId: string;
  orgId: string;
  role: string;
  isOrgOwner: boolean;
  sessionId: string;
  tokenScopes: string[] | null;
  principal: Principal;
}
