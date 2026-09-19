import { z } from "zod";

export const askOsDirectiveSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("confirm-action"),
    proposalId: z.number(),
    token: z.string(),
    action: z.string(),
    summary: z.string(),
    preview: z.record(z.string(), z.unknown()),
  }),
  z.object({
    kind: z.literal("connect-integration"),
    toolkit: z.string(),
    reason: z.enum(["no-connection", "needs-reauth"]),
    summary: z.string(),
  }),
]);

export type AskOsDirective = z.infer<typeof askOsDirectiveSchema>;
