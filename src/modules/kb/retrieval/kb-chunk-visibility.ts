import type { SQL } from "drizzle-orm";
import { kbArticleChunks } from "../../../db/schema";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { visibleTo } from "./kb-page-visibility";

export function chunkVisibleTo(
  user: CurrentUserContext,
  accessibleProjectIds: number[],
): SQL<unknown> {
  return visibleTo(
    {
      orgId: kbArticleChunks.orgId,
      visibility: kbArticleChunks.pageVisibility,
      projectId: kbArticleChunks.pageProjectId,
      createdById: kbArticleChunks.pageCreatedById,
    },
    user,
    accessibleProjectIds,
  );
}
