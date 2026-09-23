import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { KB_PAGE_GRANT_ACCESS } from "../../../../db/schema/kb/page-grants";
import { KB_PAGE_STATUSES } from "../collection/knowledge-collection.types";

export const kbSettingsSchema = z.object({
  trashRetentionDays: z.number().int(),
  chatHistoryRetentionDays: z.number().int(),
});

export const kbTagSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  slug: z.string(),
  createdAt: wireDate(),
});

export const kbTagListSchema = z.array(kbTagSchema);

export const kbTagSuccessSchema = z.object({ success: z.boolean() });

export const kbTranslationSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  articleId: z.number().int(),
  locale: z.string(),
  title: z.string(),
  content: z.string(),
  contentText: z.string(),
  excerpt: z.string().nullable(),
  status: z.enum(["draft", "published", "archived"]),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const kbTranslationListSchema = z.array(kbTranslationSchema);

export const kbTranslationSuccessSchema = z.object({ success: z.boolean() });

export const kbPageCollectionItemSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  icon: z.string().nullable(),
  coverImage: z.string().nullable(),
  spaceId: z.number().int().nullable(),
  projectId: z.number().int().nullable(),
  parentPageId: z.number().int().nullable(),
  status: z.enum(KB_PAGE_STATUSES),
  visibility: z.enum(["private", "org", "public"]),
  contentType: z.string(),
  trustState: z.enum(["unverified", "verified", "verification_expired"]),
  ownerMembershipId: z.number().int().nullable(),
  ownerUserId: z.string().nullable(),
  createdById: z.string().nullable(),
  createdByMembershipId: z.number().int().nullable(),
  lastEditedById: z.string().nullable(),
  lastEditedByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
  nextReviewAt: nullableWireDate(),
  verifiedUntil: nullableWireDate(),
  contentRevision: z.number().int(),
  aclRevision: z.number().int(),
  sharedBy: z
    .object({
      membershipId: z.number().int().nullable(),
      at: wireDate(),
      access: z.enum(KB_PAGE_GRANT_ACCESS),
    })
    .nullable(),
});

export const kbPageCollectionPageSchema = z.object({
  data: z.array(kbPageCollectionItemSchema),
  pagination: z.object({
    limit: z.number().int(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
  facets: z
    .object({
      status: z.array(
        z.object({ value: z.enum(KB_PAGE_STATUSES), count: z.number().int() }),
      ),
      space: z.array(
        z.object({
          spaceId: z.number().int().nullable(),
          count: z.number().int(),
        }),
      ),
    })
    .nullable(),
});
