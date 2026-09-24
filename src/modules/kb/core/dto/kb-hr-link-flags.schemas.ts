import { z } from "zod";

/** The three per-tenant switches for HR documents in the knowledge base. Absent = off. */
export const hrKbLinkFlagsSchema = z.object({
  link: z.boolean(),
  search: z.boolean(),
  ai: z.boolean(),
});
export type HrKbLinkFlags = z.infer<typeof hrKbLinkFlagsSchema>;

/** What an administrator sees: what is stored, what the routes will act on, and why they can differ. */
export const hrKbLinkFlagsAdminSchema = z.object({
  stored: hrKbLinkFlagsSchema,
  effective: hrKbLinkFlagsSchema,
  hrModuleEnabled: z.boolean(),
});
export type HrKbLinkFlagsAdmin = z.infer<typeof hrKbLinkFlagsAdminSchema>;

export const updateHrKbLinkFlagsSchema = z
  .object({
    link: z.boolean().optional(),
    search: z.boolean().optional(),
    ai: z.boolean().optional(),
  })
  .strict()
  .refine((body) => body.link !== undefined || body.search !== undefined || body.ai !== undefined, {
    message: "Send at least one of link, search, ai.",
  });
export type UpdateHrKbLinkFlagsInput = z.infer<typeof updateHrKbLinkFlagsSchema>;
