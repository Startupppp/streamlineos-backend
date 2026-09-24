import type { KbPageGrantAccess } from "../../../../db/schema/kb/page-grants";

export const KB_PAGE_COLLECTION_SORTS = [
  "updated_desc",
  "created_desc",
  "title_asc",
] as const;

export type KbPageCollectionSort = (typeof KB_PAGE_COLLECTION_SORTS)[number];

export const KB_PAGE_STATUSES = [
  "draft",
  "in_review",
  "published",
  "archived",
] as const;

export type KbPageStatus = (typeof KB_PAGE_STATUSES)[number];

export const KB_PAGE_COLLECTION_DEFAULT_LIMIT = 50;

export interface KbPageCollectionQuery {
  readonly q?: string;
  readonly spaceId?: number;
  readonly projectId?: number;
  readonly owner?: "me";
  readonly sharedWithMe?: boolean;
  readonly status?: readonly KbPageStatus[];
  readonly verified?: boolean;
  readonly deleted?: boolean;
  readonly sort: KbPageCollectionSort;
  readonly cursor?: string;
  readonly limit: number;
  readonly facets?: boolean;
}

export interface KbPageSharedBy {
  readonly membershipId: number | null;
  readonly at: Date;
  readonly access: KbPageGrantAccess;
}

export interface KbPageCollectionItem {
  readonly id: number;
  readonly title: string;
  readonly icon: string | null;
  readonly coverImage: string | null;
  readonly spaceId: number | null;
  readonly projectId: number | null;
  readonly parentPageId: number | null;
  readonly status: KbPageStatus;
  readonly visibility: "private" | "org" | "public";
  readonly contentType: string;
  readonly trustState: "unverified" | "verified" | "verification_expired";
  readonly ownerMembershipId: number | null;
  readonly ownerUserId: string | null;
  readonly createdById: string | null;
  readonly createdByMembershipId: number | null;
  readonly lastEditedById: string | null;
  readonly lastEditedByMembershipId: number | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
  readonly nextReviewAt: Date | null;
  readonly verifiedUntil: Date | null;
  readonly contentRevision: number;
  readonly aclRevision: number;
  readonly sharedBy: KbPageSharedBy | null;
}

export interface KbPageCollectionFacets {
  readonly status: readonly { value: KbPageStatus; count: number }[];
  readonly space: readonly { spaceId: number | null; count: number }[];
}

export interface KbPageCollectionPage {
  readonly data: readonly KbPageCollectionItem[];
  readonly pagination: {
    readonly limit: number;
    readonly hasMore: boolean;
    readonly nextCursor: string | null;
  };
  readonly facets: KbPageCollectionFacets | null;
}
