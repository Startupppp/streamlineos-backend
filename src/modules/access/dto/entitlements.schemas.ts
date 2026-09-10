import { z } from "zod";

export const toggleModuleSchema = z.object({
  enabled: z.boolean(),
}).strict();

export type ToggleModuleInput = z.infer<typeof toggleModuleSchema>;
