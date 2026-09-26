import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";
import { riskStatusEnum } from "../../../../db/schema";
import { idCursorSchema } from "../../../../common/pagination/cursor.schema";

export const orgListRisksQuerySchema = z
  .object({
    status: z.enum(riskStatusEnum.enumValues).optional(),
    cursor: idCursorSchema,
    limit: pageSizeField(50),
  })
  .strict();

export type OrgListRisksQuery = z.infer<typeof orgListRisksQuerySchema>;
