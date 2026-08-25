export const INTERNAL_TOKEN_AUDIENCE = "streamlineos-api" as const;
export const INTERNAL_TOKEN_ISSUER = "streamlineos-web" as const;

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
}
