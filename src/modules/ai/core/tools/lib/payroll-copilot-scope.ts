import type { DataScope } from "../../../../access/access.types";

export function shouldDenyTeamPayrollCopilot(scope: DataScope): boolean {
  return scope === "team";
}
