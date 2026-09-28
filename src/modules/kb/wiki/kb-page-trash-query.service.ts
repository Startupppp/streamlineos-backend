import { Inject, Injectable } from "@nestjs/common";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  sql,
  type SQL,
} from "drizzle-orm";
import { kbPages } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { BulkPageIdsInput, TrashPagesQuery } from "./dto/kb-pages.schemas";
import { KB_PAGE_LIST_COLUMNS, type KbPageListItem } from "./kb-page-columns";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import {
  buildCursorPage,
  decodeTimestampCursor,
  type CursorPage,
} from "../../../common/pagination/cursor";
import {
  keysetBeforeMicros,
  microsecondCursorValue,
} from "../../../common/pagination/keyset";
import { collectSubtreeIds } from "./kb-page-subtree.util";

@Injectable()
export class KbPageTrashQueryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly auth: KnowledgeAuthorizationService,
  ) {}

  async getTrash(
    user: CurrentUserContext,
    query: TrashPagesQuery,
  ): Promise<CursorPage<KbPageListItem>> {
    const orgId = user.orgId;
    const predicate = await this.auth.visiblePagePredicate(user, "view");
    const position = decodeTimestampCursor(query.cursor);
    const filters: SQL[] = [
      eq(kbPages.orgId, orgId),
      isNotNull(kbPages.deletedAt),
      predicate,
    ];
    if (position)
      filters.push(keysetBeforeMicros(kbPages.deletedAt, kbPages.id, position));
    if (query.spaceId !== undefined)
      filters.push(eq(kbPages.spaceId, query.spaceId));
    if (query.deletedByMembershipId !== undefined)
      filters.push(
        eq(kbPages.deletedByMembershipId, query.deletedByMembershipId),
      );
    if (query.deletedFrom !== undefined)
      filters.push(gte(kbPages.deletedAt, new Date(query.deletedFrom)));
    if (query.deletedBefore !== undefined)
      filters.push(lt(kbPages.deletedAt, new Date(query.deletedBefore)));
    if (query.q) {
      const words = query.q
        .trim()
        .split(/\s+/)
        .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
        .filter((w) => w.length > 0)
        .slice(0, 8);
      if (words.length > 0) {
        const prefixQuery = words.map((w) => `${w}:*`).join(" & ");
        filters.push(
          sql`${kbPages}.fts @@ to_tsquery('english', ${prefixQuery})`,
        );
      }
    }
    const rows = await this.db
      .select({
        ...KB_PAGE_LIST_COLUMNS,
        deletedAtText: microsecondCursorValue(kbPages.deletedAt),
      })
      .from(kbPages)
      .where(and(...filters))
      .orderBy(desc(kbPages.deletedAt), desc(kbPages.id))
      .limit(query.limit + 1);
    return buildCursorPage(rows, query.limit, (row) => ({
      sortValue: row.deletedAtText ?? "",
      id: String(row.id),
    }));
  }

  async purgeImpact(
    user: CurrentUserContext,
    input: BulkPageIdsInput,
  ): Promise<{ pageCount: number; descendantCount: number }> {
    const orgId = user.orgId;
    const predicate = await this.auth.visiblePagePredicate(user, "view");
    const found = await this.db
      .select({ id: kbPages.id })
      .from(kbPages)
      .where(
        and(
          eq(kbPages.orgId, orgId),
          inArray(kbPages.id, input.pageIds),
          predicate,
        ),
      );
    const visibleIds = found.map((p) => p.id);
    if (visibleIds.length === 0) {
      return { pageCount: 0, descendantCount: 0 };
    }
    const subtreeIds = await this.db.transaction((tx) =>
      collectSubtreeIds(tx, orgId, visibleIds),
    );
    const affected = new Set<number>(subtreeIds);
    return {
      pageCount: visibleIds.length,
      descendantCount: Math.max(0, affected.size - visibleIds.length),
    };
  }
}
