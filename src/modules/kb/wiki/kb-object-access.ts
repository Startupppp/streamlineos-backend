import { NotFoundException } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { kbPageAttachments, kbPages } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";

export const KB_OBJECT_KEY_FOLDERS: ReadonlySet<string> = new Set(["kb-media", "kb-sources"]);

export async function assertKbObjectReadable(
  db: Db,
  auth: KnowledgeAuthorizationService,
  user: CurrentUserContext,
  fileKey: string,
  notFoundMessage: string,
): Promise<void> {
  const attachment = await db.query.kbPageAttachments.findFirst({
    where: and(
      eq(kbPageAttachments.orgId, user.orgId),
      eq(kbPageAttachments.fileKey, fileKey),
      isNull(kbPageAttachments.deletedAt),
    ),
    columns: { pageId: true, uploadedById: true },
  });
  if (!attachment) throw new NotFoundException(notFoundMessage);

  if (attachment.pageId !== null) {
    await auth.assertPageAccess(user, attachment.pageId, "view");
    return;
  }

  const cover = await db.query.kbPages.findFirst({
    where: and(
      eq(kbPages.orgId, user.orgId),
      isNull(kbPages.deletedAt),
      sql`split_part(${kbPages.coverImage}, '#', 1) = ${fileKey}`,
    ),
    columns: { id: true },
  });
  if (cover) {
    await auth.assertPageAccess(user, cover.id, "view");
    return;
  }

  if (attachment.uploadedById !== user.userId) throw new NotFoundException(notFoundMessage);
}
