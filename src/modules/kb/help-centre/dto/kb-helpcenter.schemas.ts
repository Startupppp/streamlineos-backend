import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";

export const verificationQueueSchema = z.object({
  page: pageNumberField,
  pageSize: pageSizeField(20, 100),
});

export type VerificationQueueInput = z.infer<typeof verificationQueueSchema>;
