import { z } from "zod";
import {
  PAGE_SIZE_CAP,
  pageSizeField,
} from "../../../../common/pagination/list-query.schema";

export const KB_PAGE_TREE_PAGE_SIZE = 50;

export const listPageTreeChildrenSchema = z
  .object({
    parentId: z.coerce.number().int().positive().optional(),
    spaceId: z.coerce.number().int().positive().optional(),
    projectId: z.coerce.number().int().positive().optional(),
    cursor: z.string().optional(),
    limit: pageSizeField(KB_PAGE_TREE_PAGE_SIZE, PAGE_SIZE_CAP),
  })
  .strict();

export type ListPageTreeChildrenInput = z.infer<
  typeof listPageTreeChildrenSchema
>;
