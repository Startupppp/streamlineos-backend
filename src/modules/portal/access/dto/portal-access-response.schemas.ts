import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

const membershipListItemSchema = z.object({
  portalMembershipId: z.string(),
  organizationId: z.string(),
  audience: z.string().nullable(),
  partyContactId: z.string(),
  userMembershipId: z.number().int().nullable(),
  status: z.string(),
  sessionEpoch: z.number().int(),
  deletedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  contactFirstName: z.string().nullable(),
  contactLastName: z.string().nullable(),
});

export const membershipListSchema = cursorPageSchema(membershipListItemSchema);

const membershipRowSchema = z.object({
  portalMembershipId: z.string(),
  organizationId: z.string(),
  audience: z.string().nullable(),
  partyContactId: z.string(),
  userMembershipId: z.number().int().nullable(),
  status: z.string(),
  sessionEpoch: z.number().int(),
  deletedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const membershipRowSchema_ = membershipRowSchema;

const grantListItemSchema = z.object({
  projectClientGrantId: z.string(),
  organizationId: z.string(),
  portalMembershipId: z.string(),
  partyContactId: z.string(),
  projectId: z.number().int(),
  pmWorkspaceId: z.string(),
  canViewMilestones: z.boolean(),
  canViewTasks: z.boolean(),
  canViewAttachments: z.boolean(),
  canViewComments: z.boolean(),
  canSubmitChangeRequests: z.boolean(),
  status: z.string(),
  expiresAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  contactFirstName: z.string().nullable(),
  contactLastName: z.string().nullable(),
});

export const grantListSchema = cursorPageSchema(grantListItemSchema);

const grantRowSchema = z.object({
  projectClientGrantId: z.string(),
  organizationId: z.string(),
  portalMembershipId: z.string(),
  partyContactId: z.string(),
  projectId: z.number().int(),
  pmWorkspaceId: z.string(),
  canViewMilestones: z.boolean(),
  canViewTasks: z.boolean(),
  canViewAttachments: z.boolean(),
  canViewComments: z.boolean(),
  canSubmitChangeRequests: z.boolean(),
  status: z.string(),
  expiresAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export { grantRowSchema };
