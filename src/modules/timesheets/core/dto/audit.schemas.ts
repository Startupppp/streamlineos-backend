import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const auditQuerySchema = z.object({
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  action: z.string().optional(),
  cursor: z.string().optional(),
  limit: pageSizeField(50, 100),
}).strict();
export type AuditQuery = z.infer<typeof auditQuerySchema>;
