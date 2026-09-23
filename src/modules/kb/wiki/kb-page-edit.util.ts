import { HttpException, HttpStatus } from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { kbPages, kbPageLinks, kbPageVersions, users } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { isUniqueViolationOn } from "../../../common/db/postgres-error";
import { extractPageLinkIds } from "./kb-page-content.util";

const VERSION_WINDOW_MS = 10 * 60 * 1000;

const VERSION_NUMBER_INDEX = "uniq_kb_page_versions_page_version";

export const STALE_REVISION_CODE = "STALE_REVISION";

export interface KbPageConflictDetails {
  currentContentRevision: number | null;
  lastEditedByName: string | null;
  lastEditedAt: string | null;
}

export const NO_KB_PAGE_CONFLICT_DETAILS: KbPageConflictDetails = {
  currentContentRevision: null,
  lastEditedByName: null,
  lastEditedAt: null,
};

export function staleRevisionConflict(details: KbPageConflictDetails): HttpException {
  return new HttpException(
    {
      message: "Page was modified by another editor. Reload to see the latest version.",
      code: STALE_REVISION_CODE,
      details,
    },
    HttpStatus.CONFLICT,
  );
}

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
  try {
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
  } catch (error) {
    if (!isUniqueViolationOn(error, VERSION_NUMBER_INDEX)) throw error;
    throw staleRevisionConflict(NO_KB_PAGE_CONFLICT_DETAILS);
  }
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

export async function buildPageAncestors(
  db: Db,
  orgId: string,
  parentId: number | null,
): Promise<Array<{ id: number; title: string }>> {
  if (parentId === null) return [];
  const rows = await db.execute(sql`
    WITH RECURSIVE ancestors AS (
      SELECT id, title, parent_page_id, 1 AS depth
      FROM kb_pages
      WHERE id = ${parentId} AND org_id = ${orgId}
      UNION ALL
      SELECT p.id, p.title, p.parent_page_id, a.depth + 1
      FROM kb_pages p
      INNER JOIN ancestors a ON p.id = a.parent_page_id AND a.depth < 100
      WHERE p.org_id = ${orgId}
    )
    SELECT id, title FROM ancestors ORDER BY depth DESC
  `);
  return rows.map((row) => ({
    id: Number(row.id),
    title: String(row.title ?? ""),
  }));
}

export async function describeLatestPageEdit(
  tx: KbTransaction,
  orgId: string,
  pageId: number,
): Promise<KbPageConflictDetails> {
  const [latest] = await tx
    .select({
      contentRevision: kbPages.contentRevision,
      updatedAt: kbPages.updatedAt,
      editorName: users.name,
    })
    .from(kbPages)
    .leftJoin(users, eq(kbPages.lastEditedById, users.id))
    .where(and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId)))
    .limit(1);
  if (!latest) return NO_KB_PAGE_CONFLICT_DETAILS;
  return {
    currentContentRevision: latest.contentRevision,
    lastEditedByName: latest.editorName,
    lastEditedAt: latest.updatedAt.toISOString(),
  };
}
