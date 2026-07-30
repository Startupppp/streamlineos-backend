export interface BackendClaims {
  sub: string;
  orgId: string | null;
  branchId: string | null;
  role: string;
  permissions: string[];
  enabledModules: string[];
  plan: string | null;
  isOrgOwner: boolean;
  sessionId: string;
}

export interface CurrentUserContext {
  userId: string;
  orgId: string;
  branchId: string | null;
  role: string;
  permissions: string[];
  enabledModules: string[];
  plan: string | null;
  isOrgOwner: boolean;
  sessionId: string;
}