import { PgDialect } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";
import { getTableName } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { kbArticleChunks, kbPages } from "../../../src/db/schema";

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
  pageId: number;
  content: string;
}

export type FakeTable = "kb_article_chunks" | "kb_pages" | "other";

export interface InsertedRow {
  table: string;
  values: Record<string, unknown>;
}

export interface RecordedQuery {
  table: FakeTable;
  joins: FakeTable[];
  sql: string;
  params: unknown[];
}

const dialect = new PgDialect();
const OWNER_COLUMN = '"kb_pages"."owner_membership_id" = $';

function compile(where: SQL | undefined): { sql: string; params: unknown[] } {
  if (where === undefined) return { sql: "", params: [] };
  const query = dialect.sqlToQuery(where);
  return { sql: query.sql, params: query.params };
}

/** The membership id the predicate confines articles to, or `undefined` for none. */
export function ownerBoundIn(recorded: RecordedQuery): number | undefined {
  const at = recorded.sql.indexOf(OWNER_COLUMN);
  if (at === -1) return undefined;
  const index = Number.parseInt(
    recorded.sql.slice(at + OWNER_COLUMN.length),
    10,
  );
  const value = recorded.params[index - 1];
  return typeof value === "number" ? value : undefined;
}

export function refusesEverything(recorded: RecordedQuery): boolean {
  return /\bfalse\b/.test(recorded.sql);
}

function idsBoundIn(
  recorded: RecordedQuery,
  qualified: string,
): number[] | undefined {
  const marker = `${qualified} in (`;
  const at = recorded.sql.indexOf(marker);
  if (at === -1) return undefined;
  const close = recorded.sql.indexOf(")", at);
  const ids: number[] = [];
  for (const token of recorded.sql
    .slice(at + marker.length, close)
    .split(",")) {
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
  const inserted: InsertedRow[] = [];

  const articlesMatching = (query: RecordedQuery): ArticleFixture[] => {
    if (refusesEverything(query)) return [];
    const owner = ownerBoundIn(query);
    const allowed = idsBoundIn(query, '"kb_pages"."id"');
    return fixtures.articles.filter(
      (a) =>
        (owner === undefined || a.ownerMembershipId === owner) &&
        (allowed === undefined || allowed.includes(a.id)),
    );
  };

  const isWikiQuery = (query: RecordedQuery): boolean =>
    query.sql.includes('"kb_pages"."content_type" <>');

  const resolve = (query: RecordedQuery): Record<string, unknown>[] => {
    if (query.table === "kb_pages") {
      if (isWikiQuery(query)) return [];
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
    if (query.joins.includes("kb_pages")) {
      if (isWikiQuery(query)) return [];
      const visible = new Set(articlesMatching(query).map((a) => a.id));
      const offered =
        idsBoundIn(query, '"kb_article_chunks"."id"') ?? fixtures.annChunkIds;
      return fixtures.chunks
        .filter((c) => offered.includes(c.id) && visible.has(c.pageId))
        .map((c) => ({ pageId: c.pageId, content: c.content }));
    }
    if (query.joins.length > 0) return [];
    return [{ id: fixtures.chunks[0]?.id ?? 1 }];
  };

  const tableOf = (value: unknown): FakeTable => {
    if (value === kbArticleChunks) return "kb_article_chunks";
    if (value === kbPages) return "kb_pages";
    return "other";
  };

  const chain = () => {
    const state: RecordedQuery = {
      table: "other",
      joins: [],
      sql: "",
      params: [],
    };
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

  const db: {
    select: () => unknown;
    selectDistinct: () => unknown;
    execute: (statement: unknown) => Promise<unknown[]>;
    transaction: <T>(fn: (tx: typeof db) => Promise<T> | T) => Promise<T>;
    insert: (table: PgTable) => {
      values: (values: Record<string, unknown>) => Promise<unknown[]>;
    };
  } = {
    transaction: async (fn) => fn(db),
    insert: (table: PgTable) => ({
      values: (values: Record<string, unknown>) => {
        inserted.push({ table: getTableName(table), values });
        return Promise.resolve([]);
      },
    }),
    select: () => chain(),
    selectDistinct: () => chain(),
    execute: (statement: unknown) => {
      const text = JSON.stringify(statement);
      executed.push(text);
      if (text.includes("hnsw.iterative_scan")) return Promise.resolve([]);
      if (text.includes("search_kb_page_ids"))
        return Promise.resolve(
          fixtures.keywordArticleIds.map((id) => ({ id })),
        );
      if (text.includes("ORDER BY embedding"))
        return Promise.resolve(fixtures.annChunkIds.map((id) => ({ id })));
      if (text.includes("kb_article_chunks"))
        return Promise.resolve([{ one: 1 }]);
      return Promise.resolve([]);
    },
  };

  return { db, recorded, executed, inserted };
}
