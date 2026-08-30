export type MemberLifecycleStatus = "active" | "suspended" | "archived";

export function membershipStatusToUserStatus(
  status: "INVITED" | "ACTIVE" | "SUSPENDED" | "LEFT",
): MemberLifecycleStatus {
  if (status === "SUSPENDED") return "suspended";
  if (status === "LEFT") return "archived";
  return "active";
}

export function userStatusToMembershipStatus(
  status: MemberLifecycleStatus,
): "ACTIVE" | "SUSPENDED" | "LEFT" {
  if (status === "suspended") return "SUSPENDED";
  if (status === "archived") return "LEFT";
  return "ACTIVE";
}
