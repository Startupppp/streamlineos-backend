import { z } from "zod";

export const setModuleOwnerSchema = z.object({
  ownerMembershipId: z.number().int().positive(),
});

export const initiateOrgTransferSchema = z.object({
  toMembershipId: z.number().int().positive(),
  expiresInHours: z.number().int().min(1).max(168).default(48),
  reason: z.string().max(500).optional(),
});

export const initiateModuleTransferSchema = z.object({
  toMembershipId: z.number().int().positive(),
  expiresInHours: z.number().int().min(1).max(168).default(48),
  reason: z.string().max(500).optional(),
});

export const declineTransferSchema = z.object({
  reason: z.string().max(500).optional(),
});

export const listTransfersSchema = z.object({
  scope: z.enum(["ORGANIZATION", "MODULE"]).optional(),
  status: z.enum(["PENDING", "ACCEPTED", "DECLINED", "CANCELLED", "EXPIRED"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const forceTransferOrgSchema = z.object({
  toMembershipId: z.number().int().positive(),
  reason: z.string().max(500).optional(),
});

export type SetModuleOwnerInput = z.infer<typeof setModuleOwnerSchema>;
export type InitiateOrgTransferInput = z.infer<typeof initiateOrgTransferSchema>;
export type InitiateModuleTransferInput = z.infer<typeof initiateModuleTransferSchema>;
export type DeclineTransferInput = z.infer<typeof declineTransferSchema>;
export type ListTransfersInput = z.infer<typeof listTransfersSchema>;
export type ForceTransferOrgInput = z.infer<typeof forceTransferOrgSchema>;
