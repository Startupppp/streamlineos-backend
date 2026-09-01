import { z } from "zod";

export const quarantineListQuerySchema = z
  .object({
    status: z.enum(["pending_scan", "clean", "infected", "error"]).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
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
