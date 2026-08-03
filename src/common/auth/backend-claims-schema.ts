import { z } from "zod";

export const backendJwtPayloadSchema = z.object({
  sub: z.string().min(1),
  sessionId: z.string().min(1),
  orgId: z
    .union([z.string(), z.null()])
    .optional()
    .transform((value) => (value ? value : null)),
});
