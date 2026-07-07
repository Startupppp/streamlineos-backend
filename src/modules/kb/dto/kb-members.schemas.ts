import { z } from "zod";

export const KB_SPACE_ROLES = ["viewer", "commenter", "editor", "publisher", "admin"] as const;

export const addMemberSchema = z
  .object({
    userId: z.string().trim().min(1).optional(),
    role: z.string().trim().min(1).optional(),
    spaceRole: z.enum(KB_SPACE_ROLES),
  })
  .refine((d) => (d.userId ? 1 : 0) + (d.role ? 1 : 0) === 1, "Provide exactly one of userId or role");
export type AddMemberInput = z.infer<typeof addMemberSchema>;
