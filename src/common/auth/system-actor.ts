import type { CurrentUserContext } from "./backend-claims";
import { systemJobPrincipal } from "./principal";
import { type SystemJobId, systemJobCeiling } from "./system-jobs";

export function systemActor(
  jobId: SystemJobId,
  orgId: string,
  onBehalfOfUserId?: string,
): CurrentUserContext {
  return {
    userId: onBehalfOfUserId ?? "system",
    orgId,
    role: "system",
    isOrgOwner: false,
    sessionId: `system:${jobId}`,
    tokenScopes: [...systemJobCeiling(jobId)],
    principal: systemJobPrincipal(jobId),
  };
}
