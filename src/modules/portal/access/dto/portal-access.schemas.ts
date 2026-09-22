import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

const membershipStatusValues = ["ACTIVE", "SUSPENDED", "REVOKED"] as const;
const grantStatusValues = ["ACTIVE", "SUSPENDED", "REVOKED", "EXPIRED"] as const;

export const GRANT_CAPABILITY_KEYS = [
  "canViewMilestones",
  "canViewTasks",
  "canViewAttachments",
  "canViewComments",
  "canSubmitChangeRequests",
] as const;

export type GrantCapabilityKey = (typeof GRANT_CAPABILITY_KEYS)[number];

export const listMembershipsQuerySchema = z.object({
  limit: pageSizeField(20, 100),
  cursor: z.string().optional(),
  status: z.enum(["PENDING", "ACTIVE", "SUSPENDED", "REVOKED"]).optional(),
}).strict();

export const createMembershipSchema = z.object({
  partyContactId: z.string().min(1),
  userMembershipId: z.number().int().positive().optional(),
}).strict();

export const updateMembershipStatusSchema = z.object({
  status: z.enum(membershipStatusValues),
}).strict();

export const listGrantsQuerySchema = z.object({
  limit: pageSizeField(20, 100),
  cursor: z.string().optional(),
  projectId: z.coerce.number().int().positive().optional(),
  q: z.string().max(200).optional(),
  permission: z
    .string()
    .optional()
    .superRefine((v, ctx) => {
      if (!v) return;
      for (const key of v.split(",")) {
        if (!(GRANT_CAPABILITY_KEYS as readonly string[]).includes(key)) {
          ctx.addIssue({ code: "custom", message: `Unknown permission key: ${key}` });
        }
      }
    }),
  state: z.enum(["active", "expired", "suspended", "revoked"]).optional(),
}).strict();

export const createGrantSchema = z.object({
  portalMembershipId: z.string().min(1),
  projectId: z.number().int().positive(),
  pmWorkspaceId: z.string().optional(),
  canViewMilestones: z.boolean().optional(),
  canViewTasks: z.boolean().optional(),
  canViewAttachments: z.boolean().optional(),
  canViewComments: z.boolean().optional(),
  canSubmitChangeRequests: z.boolean().optional(),
}).strict();

export const updateGrantSchema = z.object({
  canViewMilestones: z.boolean().optional(),
  canViewTasks: z.boolean().optional(),
  canViewAttachments: z.boolean().optional(),
  canViewComments: z.boolean().optional(),
  canSubmitChangeRequests: z.boolean().optional(),
  status: z.enum(grantStatusValues).optional(),
  expiresAt: z.string().datetime().nullish(),
}).strict();

export type ListMembershipsQuery = z.infer<typeof listMembershipsQuerySchema>;
export type CreateMembershipInput = z.infer<typeof createMembershipSchema>;
export type UpdateMembershipStatusInput = z.infer<typeof updateMembershipStatusSchema>;
export type ListGrantsQuery = z.infer<typeof listGrantsQuerySchema>;
export type CreateGrantInput = z.infer<typeof createGrantSchema>;
export type UpdateGrantInput = z.infer<typeof updateGrantSchema>;
