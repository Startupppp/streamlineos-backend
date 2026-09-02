import { z } from "zod";

export const setSourcePreferenceSchema = z.object({
  enabled: z.boolean(),
}).strict();

export type SetSourcePreferenceInput = z.infer<typeof setSourcePreferenceSchema>;
