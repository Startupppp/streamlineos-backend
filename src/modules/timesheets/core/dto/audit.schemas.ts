import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";

export const auditQuerySchema = z.object({
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  action: z.string().optional(),
  page: pageNumberField,
  limit: pageSizeField(50, 100),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;
