import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { kbPages, kbPageLinks, kbPageVersions } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { extractPageLinkIds } from "./kb-page-content.util";

const VERSION_WINDOW_MS = 10 * 60 * 1000;

export type KbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function snapshotIfNeeded(
  tx: KbTransaction,
  orgId: string,
  page: {
    id: number;
    title: string;
    content: (typeof kbPageVersions.$inferSelect)["content"];
    contentText: string | null | undefined;
  },
  authorId: string,
  changeSummary: string | null = null,
  force = false,
  authorMembershipId: number | null = null,
): Promise<void> {
  if (!page.content) return;

  const newest = await tx.query.kbPageVersions.findFirst({
    where: and(eq(kbPageVersions.pageId, page.id), eq(kbPageVersions.orgId, orgId)),
    orderBy: [desc(kbPageVersions.versionNumber)],
    columns: { versionNumber: true, createdAt: true },
  });

  const windowPassed =
    force || !newest || Date.now() - newest.createdAt.getTime() > VERSION_WINDOW_MS;

  if (!windowPassed) return;

  const nextVer = (newest?.versionNumber ?? 0) + 1;
  await tx.insert(kbPageVersions).values({
    orgId,
    pageId: page.id,
    versionNumber: nextVer,
    title: page.title,
    content: page.content,
    contentText: page.contentText ?? null,
    changeSummary,
    authorId,
    authorMembershipId,
  });
}

export async function resyncPageLinks(
  tx: KbTransaction,
  orgId: string,
  pageId: number,
  content: unknown,
): Promise<void> {
  const linkIds = extractPageLinkIds(content);

  await tx
    .delete(kbPageLinks)
    .where(
      and(
        eq(kbPageLinks.sourcePageId, pageId),
        eq(kbPageLinks.orgId, orgId),
        eq(kbPageLinks.targetType, "page"),
      ),
    );

  if (linkIds.length === 0) return;

  const validPages = await tx
    .select({ id: kbPages.id })
    .from(kbPages)
    .where(
      and(
        eq(kbPages.orgId, orgId),
        isNull(kbPages.deletedAt),
        sql`${kbPages.id} = ANY(ARRAY[${sql.join(
          linkIds.map((id) => sql`${id}`),
          sql`, `,
        )}]::int[])`,
      ),
    );

  if (validPages.length === 0) return;
  await tx
    .insert(kbPageLinks)
    .values(validPages.map((p) => ({ orgId, sourcePageId: pageId, targetPageId: p.id })))
    .onConflictDoNothing();
}
