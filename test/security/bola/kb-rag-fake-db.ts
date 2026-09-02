import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { kbArticleChunks, kbArticles, kbPages } from "../../../src/db/schema";

/**
 * A predicate-honouring stand-in for the KB tables. Each query's real WHERE is
 * compiled with drizzle's own dialect and then answered from fixtures the way
 * Postgres would for the dimension under test — the article owner — so "the asker
 * never sees the chunk" is a behavioural result of the SQL rather than a
 * restatement of the source text.
 */

export interface ArticleFixture {
  id: number;
  ownerMembershipId: number;
  title: string;
  slug: string;
  spaceId: number | null;
  contentText: string;
  updatedAt: Date;
}

export interface ChunkFixture {
  id: number;
  articleId: number;
  content: string;
}

export type FakeTable = "kb_articles" | "kb_article_chunks" | "kb_pages" | "other";

export interface RecordedQuery {
  table: FakeTable;
  joins: FakeTable[];
  sql: string;
  params: unknown[];
}

const dialect = new PgDialect();
const OWNER_COLUMN = '"kb_articles"."owner_membership_id" = $';

function compile(where: SQL | undefined): { sql: string; params: unknown[] } {
  if (where === undefined) return { sql: "", params: [] };
  const query = dialect.sqlToQuery(where);
  return { sql: query.sql, params: query.params };
}

/** The membership id the predicate confines articles to, or `undefined` for none. */
export function ownerBoundIn(recorded: RecordedQuery): number | undefined {
  const at = recorded.sql.indexOf(OWNER_COLUMN);
  if (at === -1) return undefined;
  const index = Number.parseInt(recorded.sql.slice(at + OWNER_COLUMN.length), 10);
  const value = recorded.params[index - 1];
  return typeof value === "number" ? value : undefined;
}

export function refusesEverything(recorded: RecordedQuery): boolean {
  return /\bfalse\b/.test(recorded.sql);
}

function idsBoundIn(recorded: RecordedQuery, qualified: string): number[] | undefined {
  const marker = `${qualified} in (`;
  const at = recorded.sql.indexOf(marker);
  if (at === -1) return undefined;
  const close = recorded.sql.indexOf(")", at);
  const ids: number[] = [];
  for (const token of recorded.sql.slice(at + marker.length, close).split(",")) {
    const index = Number.parseInt(token.trim().replace("$", ""), 10);
    const value = recorded.params[index - 1];
    if (typeof value === "number") ids.push(value);
  }
  return ids;
}

export interface FakeDbFixtures {
  articles: ArticleFixture[];
  chunks: ChunkFixture[];
  /** Chunk ids the ANN index offers before any predicate is applied. */
  annChunkIds: number[];
  /** Article ids the SECURITY DEFINER keyword function offers, pre-predicate. */
  keywordArticleIds: number[];
}

export function makeFakeKbDb(fixtures: FakeDbFixtures) {
  const recorded: RecordedQuery[] = [];
  const executed: string[] = [];

  const articlesMatching = (query: RecordedQuery): ArticleFixture[] => {
    if (refusesEverything(query)) return [];
    const owner = ownerBoundIn(query);
    const allowed = idsBoundIn(query, '"kb_articles"."id"');
    return fixtures.articles.filter(
      (a) =>
        (owner === undefined || a.ownerMembershipId === owner) &&
        (allowed === undefined || allowed.includes(a.id)),
    );
  };

  const resolve = (query: RecordedQuery): Record<string, unknown>[] => {
    if (query.table === "kb_articles") {
      return articlesMatching(query).map((a) => ({
        id: a.id,
        title: a.title,
        slug: a.slug,
        spaceId: a.spaceId,
        categoryId: null,
        excerpt: null,
        status: "published",
        contentText: a.contentText,
        updatedAt: a.updatedAt,
        totalCount: String(fixtures.articles.length),
        count: fixtures.articles.length,
      }));
    }
    if (query.table !== "kb_article_chunks") return [];
    if (query.joins.includes("kb_articles")) {
      const visible = new Set(articlesMatching(query).map((a) => a.id));
      const offered =
        idsBoundIn(query, '"kb_article_chunks"."id"') ?? fixtures.annChunkIds;
      return fixtures.chunks
        .filter((c) => offered.includes(c.id) && visible.has(c.articleId))
        .map((c) => ({ articleId: c.articleId, content: c.content }));
    }
    if (query.joins.length > 0) return [];
    return [{ id: fixtures.chunks[0]?.id ?? 1 }];
  };

  const tableOf = (value: unknown): FakeTable => {
    if (value === kbArticles) return "kb_articles";
    if (value === kbArticleChunks) return "kb_article_chunks";
    if (value === kbPages) return "kb_pages";
    return "other";
  };

  const chain = () => {
    const state: RecordedQuery = { table: "other", joins: [], sql: "", params: [] };
    let rows: Record<string, unknown>[] = [];
    const builder: Record<string, unknown> = {
      from(table: unknown) {
        state.table = tableOf(table);
        return builder;
      },
      innerJoin(table: unknown) {
        state.joins.push(tableOf(table));
        return builder;
      },
      leftJoin(table: unknown) {
        state.joins.push(tableOf(table));
        return builder;
      },
      where(condition: SQL | undefined) {
        const compiled = compile(condition);
        state.sql = compiled.sql;
        state.params = compiled.params;
        recorded.push({ ...state, joins: [...state.joins] });
        rows = resolve(state);
        return builder;
      },
      orderBy: () => builder,
      offset: () => Promise.resolve(rows),
      limit: () => Promise.resolve(rows),
      then: (onFulfilled: (value: Record<string, unknown>[]) => unknown) =>
        Promise.resolve(rows).then(onFulfilled),
    };
    return builder;
  };

  const db = {
    select: () => chain(),
    selectDistinct: () => chain(),
    execute: (statement: unknown) => {
      const text = JSON.stringify(statement);
      executed.push(text);
      if (text.includes("hnsw.iterative_scan")) return Promise.resolve([]);
      if (text.includes("search_kb_article_ids"))
        return Promise.resolve(fixtures.keywordArticleIds.map((id) => ({ id })));
      if (text.includes("search_kb_page_ids")) return Promise.resolve([]);
      if (text.includes("ORDER BY embedding"))
        return Promise.resolve(fixtures.annChunkIds.map((id) => ({ id })));
      if (text.includes("kb_article_chunks")) return Promise.resolve([{ one: 1 }]);
      return Promise.resolve([]);
    },
  };

  return { db, recorded, executed };
}
