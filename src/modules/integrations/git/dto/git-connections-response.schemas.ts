import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";

const gitProvider = z.enum(["github", "gitlab", "bitbucket"]);

const gitConnectionRowSchema = z.object({
  id: z.number().int().positive(),
  provider: gitProvider,
  projectId: z.number().int().nullable(),
  repoUrl: z.string(),
  repoName: z.string().nullable(),
  isActive: z.boolean(),
  webhookUrl: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const gitConnectionListItemSchema = gitConnectionRowSchema.extend({
  maskedSecret: z.string(),
});

export const gitConnectionsListResponseSchema = z.object({
  data: z.array(gitConnectionListItemSchema),
  pagination: z.object({
    limit: z.number().int().positive(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
});

export const gitConnectionCreateResponseSchema = gitConnectionRowSchema.extend({
  webhookSecret: z.string(),
});

export const gitConnectionUpdateResponseSchema = z.object({
  id: z.number().int().positive(),
  provider: gitProvider,
  projectId: z.number().int().nullable(),
  repoUrl: z.string(),
  repoName: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const gitConnectionDeleteResponseSchema = z.object({ success: z.literal(true) });

export const gitWebhookAckResponseSchema = z.object({ ok: z.literal(true) });
