import { z } from "zod";
import { notificationChannelEnum } from "../../../db/schema/common/enums";

/** SCH-003. Self-scoped: no subject id — the caller is always the subject (§6). */
export const preferenceRuleSchema = z
  .object({
    scopeType: z.enum(["EVENT", "MODULE", "CATEGORY"]),
    scopeKey: z.string().min(1).max(120),
    channel: z.enum(notificationChannelEnum.enumValues),
    mode: z.enum(["ON", "OFF", "DIGEST"]),
  })
  .strict();

export type PreferenceRuleBody = z.infer<typeof preferenceRuleSchema>;
