import { z } from "zod";
import { nullableWireDate } from "../../../../common/openapi/wire-types";
import {
  portalProjectItemSchema,
  portalMilestoneSchema,
  portalTaskSchema,
  portalAttachmentSchema,
  portalCommentSchema,
} from "./client-portal-response.schemas";

export const portalSettingsSchema = z.object({
  portalPublishedAt: nullableWireDate(),
  grantCount: z.number().int().nonnegative(),
});

export const portalPreviewSchema = z.object({
  project: portalProjectItemSchema,
  milestones: z.array(portalMilestoneSchema),
  tasks: z.array(portalTaskSchema),
  attachments: z.array(portalAttachmentSchema),
  comments: z.array(portalCommentSchema),
});
