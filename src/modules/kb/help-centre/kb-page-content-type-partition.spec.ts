import { is, SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  SUPPORT_ARTICLE_CONTENT_TYPE,
  supportArticlePredicate,
  wikiContentTypeOnly,
  wikiPagePredicate,
} from "./kb-article-page-scope";

const dialect = new PgDialect();

function render(clause: SQL): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(clause);
  return { sql: query.sql.toLowerCase(), params: [...query.params] };
}

describe("kb_pages is partitioned by content_type into exactly two live surfaces", () => {
  it("names content_type on both halves, so neither surface reads the whole table", () => {
    for (const predicate of [supportArticlePredicate(), wikiPagePredicate()]) {
      const { sql, params } = render(predicate);
      expect(sql).toContain(`"content_type"`);
      expect(params).toContain(SUPPORT_ARTICLE_CONTENT_TYPE);
    }
  });

  it("opposes the two halves on the same column, so one row cannot satisfy both", () => {
    expect(render(supportArticlePredicate()).sql).toContain(`"content_type" =`);
    expect(render(wikiPagePredicate()).sql).toContain(`"content_type" <>`);
  });

  it("filters deleted_at on both halves, so a soft-deleted page reaches neither surface", () => {
    expect(render(supportArticlePredicate()).sql).toContain(`"deleted_at" is null`);
    expect(render(wikiPagePredicate()).sql).toContain(`"deleted_at" is null`);
  });

  it("BITE: the deleted_at assertion rejects a content-type-only predicate", () => {
    const { sql } = render(wikiContentTypeOnly());

    expect(sql).toContain(`"content_type" <>`);
    expect(sql).not.toContain(`"deleted_at" is null`);
  });

  it("keeps a content-type-only predicate for the space purge, which must still reach soft-deleted pages", () => {
    const purge = render(wikiContentTypeOnly());
    const read = render(wikiPagePredicate());

    expect(purge.params).toEqual(read.params);
    expect(purge.sql).not.toEqual(read.sql);
  });

  it("returns a fresh SQL object per call, so no caller can mutate a shared predicate", () => {
    const first = supportArticlePredicate();
    const second = supportArticlePredicate();

    expect(is(first, SQL)).toBe(true);
    expect(first).not.toBe(second);
    expect(render(first).sql).toEqual(render(second).sql);
  });
});
