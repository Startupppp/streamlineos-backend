export interface BackendClaims {
  sub: string;
  orgId: string;
  branchId: number | null;
  role: string;
  permissions: string[];
  enabledModules: string[];
  plan: string | null;
  isPlatformAdmin: boolean;
  isOrgOwner: boolean;
  sessionId: string;
}

export interface CurrentUserContext {
  userId: string;
  orgId: string;
  branchId: number | null;
  role: string;
  permissions: string[];
  enabledModules: string[];
  plan: string | null;
  isPlatformAdmin: boolean;
  isOrgOwner: boolean;
  sessionId: string;
}
