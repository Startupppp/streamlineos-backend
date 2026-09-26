import { eq, sql, type SQL } from "drizzle-orm";
import { kbPages } from "../../../db/schema";
import type { TenantTx } from "../../../db/drizzle.types";
import { supportArticlePredicate } from "../help-centre/kb-article-page-scope";
import { buildArticleRestrictionBranch } from "./authorization/knowledge-page-scope";

export function publicDeliverableDocumentPredicate(orgId: string, slug: string): SQL {
  return sql`(${eq(kbPages.orgId, orgId)} AND ${eq(kbPages.slug, slug)} AND ${eq(kbPages.status, "published")} AND ${eq(kbPages.visibility, "public")} AND ${supportArticlePredicate()} AND ${buildArticleRestrictionBranch(orgId, { membershipId: null, roleSlugs: [] }, "view")})`;
}

export async function findPublicDeliverableDocument(
  tx: TenantTx,
  orgId: string,
  slug: string,
): Promise<{ id: number } | undefined> {
  const [row] = await tx
    .select({ id: kbPages.id })
    .from(kbPages)
    .where(publicDeliverableDocumentPredicate(orgId, slug));
  return row;
}
