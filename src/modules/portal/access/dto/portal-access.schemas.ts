import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

const membershipStatusValues = ["ACTIVE", "SUSPENDED", "REVOKED"] as const;
const grantStatusValues = ["ACTIVE", "SUSPENDED", "REVOKED", "EXPIRED"] as const;

export const listMembershipsQuerySchema = z.object({
  limit: pageSizeField(20, 100),
  cursor: z.string().optional(),
  status: z.enum(["PENDING", "ACTIVE", "SUSPENDED", "REVOKED"]).optional(),
});

export const createMembershipSchema = z.object({
  partyContactId: z.string().min(1),
  userMembershipId: z.number().int().positive().optional(),
});

export const updateMembershipStatusSchema = z.object({
  status: z.enum(membershipStatusValues),
});

export const listGrantsQuerySchema = z.object({
  limit: pageSizeField(20, 100),
  cursor: z.string().optional(),
  projectId: z.coerce.number().int().positive().optional(),
});

export const createGrantSchema = z.object({
  portalMembershipId: z.string().min(1),
  projectId: z.number().int().positive(),
  pmWorkspaceId: z.string().optional(),
  canViewMilestones: z.boolean().optional(),
  canViewTasks: z.boolean().optional(),
  canViewAttachments: z.boolean().optional(),
  canViewComments: z.boolean().optional(),
  canSubmitChangeRequests: z.boolean().optional(),
});

export const updateGrantSchema = z.object({
  canViewMilestones: z.boolean().optional(),
  canViewTasks: z.boolean().optional(),
  canViewAttachments: z.boolean().optional(),
  canViewComments: z.boolean().optional(),
  canSubmitChangeRequests: z.boolean().optional(),
  status: z.enum(grantStatusValues).optional(),
  expiresAt: z.string().datetime().nullish(),
});

export type ListMembershipsQuery = z.infer<typeof listMembershipsQuerySchema>;
export type CreateMembershipInput = z.infer<typeof createMembershipSchema>;
export type UpdateMembershipStatusInput = z.infer<typeof updateMembershipStatusSchema>;
export type ListGrantsQuery = z.infer<typeof listGrantsQuerySchema>;
export type CreateGrantInput = z.infer<typeof createGrantSchema>;
export type UpdateGrantInput = z.infer<typeof updateGrantSchema>;
