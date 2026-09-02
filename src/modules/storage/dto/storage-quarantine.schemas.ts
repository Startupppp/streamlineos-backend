import { z } from "zod";

import { pageSizeField } from "../../../common/pagination/list-query.schema";

export const quarantineListQuerySchema = z
  .object({
    status: z.enum(["pending_scan", "clean", "infected", "error"]).optional(),
    cursor: z.string().optional(),
    limit: pageSizeField(20, 100),
  })
  .strict();
export type QuarantineListQuery = z.infer<typeof quarantineListQuerySchema>;

export const quarantineIdParamSchema = z
  .object({ quarantineId: z.string().uuid() })
  .strict();
export type QuarantineIdParam = z.infer<typeof quarantineIdParamSchema>;

export const quarantineRejectBodySchema = z
  .object({ reason: z.string().min(1).max(500).optional() })
  .strict();
export type QuarantineRejectBody = z.infer<typeof quarantineRejectBodySchema>;
