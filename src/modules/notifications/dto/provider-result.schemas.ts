import { z } from "zod";

export const providerSendResultSchema = z.object({
  status: z.enum(["SENT", "FAILED"]),
  providerMessageId: z.string().optional(),
  providerResponse: z.record(z.string(), z.unknown()).optional(),
  costAmount: z.number().optional(),
  costCurrency: z.string().optional(),
  failureCode: z.string().optional(),
  failureMessage: z.string().optional(),
  retryable: z.boolean().optional(),
});

export type ProviderSendResultParsed = z.infer<typeof providerSendResultSchema>;
