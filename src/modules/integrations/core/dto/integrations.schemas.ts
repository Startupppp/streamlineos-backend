import { z } from "zod";

export const integrationToolkitSchema = z.enum(["googlecalendar", "outlook", "gmail"]);

export const returnPathSchema = z.enum(["/calendar", "/mail"]);

export const initiateConnectionSchema = z.object({
  toolkit: integrationToolkitSchema,
  returnPath: returnPathSchema.optional(),
});

export const finalizeConnectionSchema = z.object({
  connectedAccountId: z.string().min(1).max(200),
});

export type InitiateConnectionInput = z.infer<typeof initiateConnectionSchema>;
export type FinalizeConnectionInput = z.infer<typeof finalizeConnectionSchema>;
export type ReturnPath = z.infer<typeof returnPathSchema>;
