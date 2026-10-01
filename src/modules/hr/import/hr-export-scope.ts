import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AuthContextFactory } from "../../../common/auth/auth-context.factory";
import { MembershipStateService } from "../../../common/auth/membership-state.service";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { AccessService } from "../../access/access.service";
import { authorize } from "../../access/authorize";
import { ScopedRead } from "../../access/scoped-read";
import {
  HrExportProcessingError,
  narrowestExportScope,
  type HrExportJobRow,
} from "./hr-export-jobs.types";

export interface HrExportScopeDeps {
  membershipState: MembershipStateService;
  authContexts: AuthContextFactory;
  access: AccessService;
}

const ACCESS_REVOKED =
  "Your access changed before the export ran. Create a new export after access is restored.";

export async function resolveHrExportScope(
  deps: HrExportScopeDeps,
  job: HrExportJobRow,
): Promise<ScopedRead> {
  const member = await deps.membershipState.resolve(job.requestedBy, job.orgId);
  if (!member.active || member.membershipId === null) {
    throw new HrExportProcessingError("EXPORT_ACCESS_REVOKED", ACCESS_REVOKED);
  }

  const context: CurrentUserContext = {
    userId: job.requestedBy,
    orgId: job.orgId,
    role: member.role,
    isOrgOwner: member.isOwner,
    sessionId: "hr-export-worker",
    tokenScopes: null,
    principal: humanSessionPrincipal(member.membershipId, member.isOwner),
  };
  const authCtx = deps.authContexts.create(context);
  const [exportAccess, employeeAccess] = await Promise.all([
    authorize(deps.access, authCtx, "hr:export:manage"),
    authorize(deps.access, authCtx, "hr:employees:view"),
  ]);
  if (!exportAccess.allow || !employeeAccess.allow) {
    throw new HrExportProcessingError("EXPORT_ACCESS_REVOKED", ACCESS_REVOKED);
  }

  const scope = narrowestExportScope(job.requestedScope, employeeAccess.scope);
  if (scope === "none") {
    throw new HrExportProcessingError(
      "EXPORT_SCOPE_EMPTY",
      "No employee records are available in your current access scope.",
    );
  }
  return ScopedRead.of(job.orgId, job.requestedBy, scope);
}
