import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";
import { KB_PAGE_GRANT_ACCESS } from "../../../../db/schema/kb/page-grants";

export const kbPageGrantParamsSchema = z
  .object({ pageId: z.coerce.number().int().positive() })
  .strict();

export type KbPageGrantParams = z.infer<typeof kbPageGrantParamsSchema>;

export const kbPageGrantItemParamsSchema = z
  .object({
    pageId: z.coerce.number().int().positive(),
    grantId: z.coerce.number().int().positive(),
  })
  .strict();

export type KbPageGrantItemParams = z.infer<typeof kbPageGrantItemParamsSchema>;

export const kbPageGrantsListQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: pageSizeField(50, 100),
  })
  .strict();

export type KbPageGrantsListQuery = z.infer<typeof kbPageGrantsListQuerySchema>;

export const createKbPageGrantSchema = z
  .object({
    membershipId: z.number().int().positive().optional(),
    role: z.string().min(1).max(100).optional(),
    access: z.enum(KB_PAGE_GRANT_ACCESS),
  })
  .strict()
  .superRefine((val, ctx) => {
    const hasMembership = val.membershipId !== undefined;
    const hasRole = val.role !== undefined;
    if (hasMembership === hasRole) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Exactly one of membershipId or role must be provided",
      });
    }
  });

export type CreateKbPageGrantInput = z.infer<typeof createKbPageGrantSchema>;
