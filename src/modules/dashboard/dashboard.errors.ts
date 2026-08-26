import type { CurrentUserContext } from "../../common/auth/backend-claims";

export type DashboardActor = CurrentUserContext;

export type DashboardForbidden = { error: "forbidden"; message: string };

export function isForbidden(value: unknown): value is DashboardForbidden {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    (value as { error: unknown }).error === "forbidden"
  );
}
