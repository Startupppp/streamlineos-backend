import { z } from "zod";

export const listAuditEventsSchema = z.object({
  resourceType: z.string().min(1).max(80).optional(),
  resourceId: z.string().min(1).max(120).optional(),
  action: z.string().min(1).max(80).optional(),
  actorUserId: z.string().min(1).max(64).optional(),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /**
   * G1. The only way to page this list. There is no `page` here because there
   * are no callers to keep working — a trail that is appended to while it is
   * read has no stable offsets to hand out, and offering one would only invite
   * the defect the ledger lists had to be migrated away from.
   */
  cursor: z.string().min(1).max(512).optional(),
}).strict();
export type ListAuditEventsInput = z.infer<typeof listAuditEventsSchema>;
