import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ScopedRead } from "../access/scoped-read";

/** Self-service export/rectification is always full access to one's own record. */
export function selfSubjectScope(u: CurrentUserContext): ScopedRead {
  return ScopedRead.of(u.orgId, u.userId, "all");
}
