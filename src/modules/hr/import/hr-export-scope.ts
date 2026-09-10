import { ScopedRead } from "../../access/scoped-read";
import type { HrExportDataScope } from "../../../db/schema";

export function exportExecutionRead(
  orgId: string,
  requestedBy: string,
  scope: HrExportDataScope,
): ScopedRead {
  return ScopedRead.of(orgId, requestedBy, scope);
}
