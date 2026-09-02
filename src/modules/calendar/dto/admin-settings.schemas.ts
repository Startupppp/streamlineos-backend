import { z } from "zod";

export const calendarAdminSettingsSourceSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    module: z.string(),
    moduleEnabled: z.boolean(),
  })
  .strict();

export const calendarAdminSettingsResponseSchema = z
  .object({
    sources: z.array(calendarAdminSettingsSourceSchema),
  })
  .strict();

type CalendarAdminSettingsResponse = z.infer<typeof calendarAdminSettingsResponseSchema>;
