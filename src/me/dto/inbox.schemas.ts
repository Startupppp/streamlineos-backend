import { z } from "zod";
import { pageSizeField } from "../../common/pagination/list-query.schema";

export const INBOX_SECTIONS = ["ALL", "MENTIONS", "ASSIGNED_TO_ME", "APPROVALS"] as const;
export type InboxSection = (typeof INBOX_SECTIONS)[number];

export const inboxQuerySchema = z
  .object({
    section: z.enum(INBOX_SECTIONS).default("ALL"),
    limit: pageSizeField(25, 50),
    cursor: z.coerce.number().int().positive().optional(),
  })
  .strict();

export type InboxQuery = z.infer<typeof inboxQuerySchema>;
