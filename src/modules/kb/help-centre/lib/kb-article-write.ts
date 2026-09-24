import { NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { kbPages, kbPageTags, kbPageVersions, kbTags, type KbPageContent } from "../../../../db/schema";
import { actingMembershipId } from "../../../../common/auth/principal";
import { type Db } from "../../../../db/drizzle.module";
import { OutboxWriter } from "../../../../common/outbox/outbox-writer";
import { kbSlugify } from "../../core/kb.util";
import { KB_ARTICLE_COLUMNS, toArticleRow, type KbArticleRow } from "../kb-article-columns";
import { supportArticlePredicate } from "../kb-article-page-scope";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";

/**
 * What every KB article write owes, regardless of which write it is.
 *
 * `KbArticlesService` has six write entry points — create, update, publish,
 * unpublish, archive, restore — and each one does two different kinds of
 * work. The part that stays on the service is the part that differs per
 * entry point: the authorization call (`assertArticleEditable`) and the
 * status transition. The part here is the part that is the SAME every time,
 * and was previously copied into each method:
 *
 *  - a slug unique within the org (`uniqueArticleSlug` walks `-2`, `-3`, …),
 *  - the article's tag rows, delete-then-reinsert (`syncArticleTags`),
 *  - and an outbox `kb.content.index` event so retrieval reindexes it.
 *
 * That last one is the reason this file exists rather than five near-copies:
 * the emit block was duplicated verbatim in five methods, so a change to the
 * event shape had five places to miss. It must stay an `OutboxWriter.emit`
 * on the caller's `tx` — the index event has to commit with the row it
 * describes, or a crash between them leaves retrieval serving stale content.
 *
 * Plain `db`/`tx` parameters rather than a deps bag: nothing here needs
 * anything but the connection. `tx` where the work must be atomic with the
 * caller's write, `db` only for the pre-transaction slug probe.
 */

export type KbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type ArticleRow = KbArticleRow;

export type SnapshotSource = {
  id: number;
  title: string;
  content: KbPageContent | null;
  contentText: string | null;
  excerpt: string | null;
};

/** Only the two revision counters the index event carries. */
export type IndexableArticle = { contentRevision: number; aclRevision: number };

export async function uniqueArticleSlug(
  db: Db,
  orgId: string,
  base: string,
  excludeId?: number,
): Promise<string> {
  const root = kbSlugify(base) || "article";
  /*
   * One read for every candidate rather than one per suffix: the loop that
   * probed `-2`, `-3`, … issued a query per collision, so a popular title cost
   * a round trip for every article that already carried it.
   */
  const conditions: SQL[] = [
    eq(kbPages.orgId, orgId),
    sql`(${kbPages.slug} = ${root} OR ${kbPages.slug} LIKE ${root + "-%"})`,
  ];
  if (excludeId !== undefined) conditions.push(ne(kbPages.id, excludeId));
  const rows = await db
    .select({ slug: kbPages.slug })
    .from(kbPages)
    .where(and(...conditions));
  const taken = new Set(rows.flatMap((r) => (r.slug === null ? [] : [r.slug])));
  if (!taken.has(root)) return root;
  let suffix = 2;
  while (taken.has(`${root}-${suffix}`)) suffix += 1;
  return `${root}-${suffix}`;
}

export async function syncArticleTags(
  tx: KbTransaction,
  orgId: string,
  articleId: number,
  tagNames: string[],
): Promise<string[]> {
  await tx.delete(kbPageTags).where(and(eq(kbPageTags.orgId, orgId), eq(kbPageTags.pageId, articleId)));

  if (tagNames.length === 0) return [];

  const slugged = tagNames
    .map((name) => ({ name, slug: kbSlugify(name) }))
    .filter(({ slug }) => slug.length > 0);

  if (slugged.length === 0) return [];

  await tx
    .insert(kbTags)
    .values(slugged.map(({ name, slug }) => ({ orgId, name, slug })))
    .onConflictDoNothing();

  const tagRows = await tx
    .select({ id: kbTags.id, name: kbTags.name })
    .from(kbTags)
    .where(and(eq(kbTags.orgId, orgId), inArray(kbTags.slug, slugged.map((s) => s.slug))))
    .orderBy(asc(kbTags.name));

  if (tagRows.length > 0) {
    await tx
      .insert(kbPageTags)
      .values(tagRows.map((t) => ({ orgId, pageId: articleId, tagId: t.id })))
      .onConflictDoNothing();
  }

  return tagRows.map((t) => t.name);
}

export async function readArticleTags(
  tx: KbTransaction | Db,
  orgId: string,
  articleId: number,
): Promise<string[]> {
  const tagRows = await tx
    .select({ name: kbTags.name })
    .from(kbPageTags)
    .innerJoin(kbTags, eq(kbPageTags.tagId, kbTags.id))
    .where(and(eq(kbPageTags.pageId, articleId), eq(kbTags.orgId, orgId)))
    .orderBy(asc(kbTags.name));
  return tagRows.map((t) => t.name);
}

async function nextVersionNumber(tx: KbTransaction, orgId: string, articleId: number): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number>`coalesce(max(${kbPageVersions.versionNumber}), 0)::int` })
    .from(kbPageVersions)
    .where(and(eq(kbPageVersions.pageId, articleId), eq(kbPageVersions.orgId, orgId)));
  return (row?.max ?? 0) + 1;
}

export async function snapshotArticleVersion(
  tx: KbTransaction,
  orgId: string,
  article: SnapshotSource,
  userId: string,
  changeSummary?: string,
  membershipId: number | null = null,
): Promise<void> {
  const versionNumber = await nextVersionNumber(tx, orgId, article.id);
  await tx.insert(kbPageVersions).values({
    orgId,
    pageId: article.id,
    versionNumber,
    title: article.title,
    content: article.content,
    contentText: article.contentText,
    excerpt: article.excerpt,
    changeSummary: changeSummary ?? null,
    authorId: userId,
    authorMembershipId: membershipId,
  });
}

/**
 * Tells retrieval to reindex. Emitted on the caller's `tx` so the event
 * commits with the row it describes.
 */
export async function emitArticleIndexEvent(
  tx: KbTransaction,
  orgId: string,
  articleId: number,
  article: IndexableArticle,
): Promise<void> {
  await OutboxWriter.emit(tx, {
    eventId: randomUUID(),
    organizationId: orgId,
    aggregateType: "kb_article",
    aggregateId: String(articleId),
    aggregateVersion: Date.now(),
    eventType: "kb.content.index",
    payload: {
      contentType: "article",
      contentId: articleId,
      contentRevision: article.contentRevision,
      aclRevision: article.aclRevision,
    },
    occurredAt: new Date(),
  });
}

/**
 * The caller is responsible for authorizing the edit before calling this —
 * `KbArticlesService.restoreVersion` runs `assertArticleEditable` first.
 */
export async function restoreArticleVersion(
  db: Db,
  user: CurrentUserContext,
  articleId: number,
  versionNumber: number,
): Promise<ArticleRow> {
  const orgId = user.orgId;
  return db.transaction(async (tx) => {
    const [version] = await tx
      .select({
        title: kbPageVersions.title,
        content: kbPageVersions.content,
        contentText: kbPageVersions.contentText,
        excerpt: kbPageVersions.excerpt,
      })
      .from(kbPageVersions)
      .where(
        and(
          eq(kbPageVersions.pageId, articleId),
          eq(kbPageVersions.versionNumber, versionNumber),
          eq(kbPageVersions.orgId, orgId),
        ),
      )
      .limit(1);
    if (!version) throw new NotFoundException("Version not found");

    const [result] = await tx
      .update(kbPages)
      .set({
        title: version.title,
        content: version.content,
        excerpt: version.excerpt,
        contentText: version.contentText,
        /* A restore changes the content, so readers holding the old revision must see it move. */
        contentRevision: sql`content_revision + 1`,
      })
      .where(and(eq(kbPages.id, articleId), eq(kbPages.orgId, orgId), supportArticlePredicate()))
      .returning(KB_ARTICLE_COLUMNS);
    if (!result) throw new NotFoundException("Article not found");

    await snapshotArticleVersion(
      tx,
      orgId,
      result,
      user.userId,
      `Restored v${versionNumber}`,
      actingMembershipId(user.principal),
    );
    if (result.status === "published") {
      await emitArticleIndexEvent(tx, orgId, articleId, result);
    }
    return toArticleRow(result);
  });
}
