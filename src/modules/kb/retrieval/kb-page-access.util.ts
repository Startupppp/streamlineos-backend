import { NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { kbPages } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { pageVisibleTo } from "./kb-page-visibility";
import { getAccessibleProjectIds } from "./kb-project-access.util";

export async function assertPageAccessible(
  db: Db,
  user: CurrentUserContext,
  pageId: number,
): Promise<void> {
  const projectIds = await getAccessibleProjectIds(db, user);
  const page = await db.query.kbPages.findFirst({
    where: and(
      eq(kbPages.id, pageId),
      eq(kbPages.orgId, user.orgId),
      isNull(kbPages.deletedAt),
      pageVisibleTo(user, projectIds),
    ),
    columns: { id: true },
  });
  if (!page) throw new NotFoundException("Page not found");
}
