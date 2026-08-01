export type DataScope = "all" | "team" | "own" | "none";

export type DenyReason = "UNAUTHENTICATED" | "NO_MODULE" | "FORBIDDEN";

export interface AuthResult {
  allow: boolean;
  scope: DataScope;
  reason?: DenyReason;
  permissions?: string[];
}

export interface AccessSnapshot {
  permissions: string[];
  scopes: Record<string, DataScope>;
  modules: Record<string, boolean>;
  isOrgOwner: boolean;
  version: number;
}
