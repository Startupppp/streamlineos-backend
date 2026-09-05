import { z } from "zod";

export const orgModuleListResponseSchema = z.array(z.object({
  moduleKey: z.string(),
  enabled: z.boolean(),
  core: z.literal(true).optional(),
}).strict());
