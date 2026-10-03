import type { AuditService } from "../../../common/audit/audit.service";

export function lifecycleAuditDouble(): AuditService {
  const double: Pick<AuditService, "log"> = { log: jest.fn() };
  return double as AuditService;
}
