import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

export const exportJobSchema = z.object({
  id: z.string(),
  reportType: z.string(),
  status: z.string(),
  processedRows: z.number().int().nullable(),
  rowCount: z.number().int().nullable(),
  truncated: z.boolean().nullable(),
  fileName: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: wireDate(),
  completedAt: nullableWireDate(),
  expiresAt: nullableWireDate(),
});
