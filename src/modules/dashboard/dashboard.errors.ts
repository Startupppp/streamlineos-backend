export interface DashboardActor {
  userId: string;
  role: string;
  permissions: string[];
  enabledModules: string[];
  isPlatformAdmin: boolean;
  isOrgOwner: boolean;
}

export type DashboardForbidden = { error: "forbidden"; message: string };

export function isForbidden(value: unknown): value is DashboardForbidden {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    (value as { error: unknown }).error === "forbidden"
  );
}
