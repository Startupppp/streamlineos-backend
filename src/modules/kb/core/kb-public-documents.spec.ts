import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.types";
import {
  listPublicDocuments,
  findPublicDocumentBySlug,
  findPublicDocumentIdBySlug,
  publicVisibleDocuments,
  type PublicDocumentSummary,
  type PublicDocumentDetail,
} from "./kb-public-documents";

const dialect = new PgDialect();
const ORG = "org-help-centre-public";
const SLUG = "getting-started";

function render(orgId: string) {
  const { sql, params } = dialect.sqlToQuery(publicVisibleDocuments(orgId));
  return { text: sql, params: params as unknown[] };
}

function boundValue(text: string, params: unknown[], column: string): unknown {
  const match = new RegExp(`"${column}"\\s*=\\s*\\$(\\d+)`).exec(text);
  if (match === null)
    throw new Error(`no equality predicate on ${column} in: ${text}`);
  return params[Number(match[1]) - 1];
}

interface MockChain extends PromiseLike<unknown[]> {
  from: jest.Mock;
  innerJoin: jest.Mock;
  leftJoin: jest.Mock;
  where: jest.Mock;
  orderBy: jest.Mock;
  limit: jest.Mock;
}

function makeChain(rows: unknown[], wheres: SQL[]): MockChain {
  const chain = {} as MockChain;
  chain.from = jest.fn(() => chain);
  chain.innerJoin = jest.fn(() => chain);
  chain.leftJoin = jest.fn(() => chain);
  chain.orderBy = jest.fn(() => chain);
  chain.limit = jest.fn(() => chain);
  chain.where = jest.fn((condition: SQL) => {
    wheres.push(condition);
    return chain;
  });
  chain.then = (resolve, reject) =>
    Promise.resolve(rows).then(resolve ?? undefined, reject ?? undefined);
  return chain;
}

function makeDb(rows: unknown[], wheres: SQL[], projections: unknown[]): Db {
  const chain = makeChain(rows, wheres);
  return {
    select: jest.fn((projection: unknown) => {
      projections.push(projection);
      return chain;
    }),
    update: jest.fn(() => ({
      set: jest.fn(() => ({ where: jest.fn().mockResolvedValue([]) })),
    })),
  } as unknown as Db;
}

function projectionKeys(projection: unknown): string[] {
  if (typeof projection !== "object" || projection === null) return [];
  return Object.keys(projection);
}

function columnName(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const name: unknown = Reflect.get(value, "name");
  return typeof name === "string" ? name : null;
}

function selectedColumns(projection: unknown): string[] {
  if (typeof projection !== "object" || projection === null) return [];
  return Object.values(projection)
    .map(columnName)
    .filter((name): name is string => name !== null);
}

function renderWhere(where: SQL): { text: string; params: unknown[] } {
  const q = dialect.sqlToQuery(where);
  return { text: q.sql, params: q.params as unknown[] };
}

describe("publicVisibleDocuments — excluded: Document with org Visibility", () => {
  it("binds visibility to 'public' as a positive equality, so a Document with visibility 'org' cannot match", () => {
    const { text, params } = render(ORG);
    expect(boundValue(text, params, "visibility")).toBe("public");
  });

  it("does not include 'org' as an allowed visibility value", () => {
    const { params } = render(ORG);
    expect(params).not.toContain("org");
  });
});

describe("publicVisibleDocuments — excluded: Document inside a non-public Space", () => {
  it("requires Space audience to be in the allowed set, so an 'internal' Space audience cannot match", () => {
    const { text } = render(ORG);
    expect(text).toContain('"kb_spaces"."audience" in');
    expect(text).not.toContain("internal");
  });
});

describe("publicVisibleDocuments — admitted: a genuinely public Document matches the predicate", () => {
  it("includes 'public' and 'mixed' as the allowed Space audience values, so a Document in a public Space is admitted", () => {
    const { params } = render(ORG);
    expect(params).toContain("public");
    expect(params).toContain("mixed");
  });

  it("binds content_type to 'support_article', so a published help-centre Document is admitted on this check", () => {
    const { text, params } = render(ORG);
    expect(boundValue(text, params, "content_type")).toBe("support_article");
  });

  it("binds status to 'published', so a published Document is admitted on this check", () => {
    const { text, params } = render(ORG);
    expect(boundValue(text, params, "status")).toBe("published");
  });
});

describe("publicVisibleDocuments — soft-delete fence", () => {
  it("includes kb_pages.deleted_at IS NULL so a soft-deleted Document stays unreachable", () => {
    const { text } = render(ORG);
    expect(text).toContain('"kb_pages"."deleted_at" is null');
  });

  it("includes kb_spaces.deleted_at IS NULL so a Document inside a soft-deleted Space stays unreachable", () => {
    const { text } = render(ORG);
    expect(text).toContain('"kb_spaces"."deleted_at" is null');
  });
});

describe("publicVisibleDocuments — tenant isolation", () => {
  it("binds org_id to the requested tenant, so a Document from another org cannot match", () => {
    const { text, params } = render(ORG);
    expect(boundValue(text, params, "org_id")).toBe(ORG);
  });

  it("uses a different bound value per distinct org, so the predicate is not shared across tenants", () => {
    const other = "org-different";
    const { params: paramsA } = render(ORG);
    const { params: paramsB } = render(other);
    expect(paramsA).not.toEqual(paramsB);
    expect(paramsB).toContain(other);
    expect(paramsB).not.toContain(ORG);
  });
});

describe("listPublicDocuments — WHERE clause includes the Space audience fence", () => {
  it("excludes a Document in an internal-audience Space (negative: audience 'internal' is not in the allowed set)", async () => {
    const wheres: SQL[] = [];
    const db = makeDb([], wheres, []);
    await listPublicDocuments(db, ORG, { pageSize: 10 });
    const { text } = renderWhere(wheres[0]!);
    expect(text).toContain('"kb_spaces"."audience" in');
    expect(text).not.toContain("internal");
  });

  it("admits a Document in a public-audience Space (positive: 'public' and 'mixed' are the only allowed values)", async () => {
    const wheres: SQL[] = [];
    const db = makeDb([], wheres, []);
    await listPublicDocuments(db, ORG, { pageSize: 10 });
    const { params } = renderWhere(wheres[0]!);
    expect(params).toContain("public");
    expect(params).toContain("mixed");
  });

  it("binds visibility to 'public', so an org-visible Document is excluded from public listing", async () => {
    const wheres: SQL[] = [];
    const db = makeDb([], wheres, []);
    await listPublicDocuments(db, ORG, { pageSize: 10 });
    const { text, params } = renderWhere(wheres[0]!);
    expect(boundValue(text, params, "visibility")).toBe("public");
  });
});

describe("listPublicDocuments — projection matches the PublicDocumentSummary contract", () => {
  it("selects exactly the summary fields, so no internal column is exposed", async () => {
    const projections: unknown[] = [];
    const db = makeDb([], [], projections);
    await listPublicDocuments(db, ORG, { pageSize: 10 });
    expect(projectionKeys(projections[0])).toEqual([
      "id",
      "categoryId",
      "title",
      "slug",
      "excerpt",
      "views",
      "helpfulCount",
      "notHelpfulCount",
      "tags",
      "publishedAt",
    ]);
  });

  it("does not project visibility, content_type, deleted_at or other internal columns", async () => {
    const projections: unknown[] = [];
    const db = makeDb([], [], projections);
    await listPublicDocuments(db, ORG, { pageSize: 10 });
    const cols = selectedColumns(projections[0]);
    for (const internal of [
      "visibility",
      "content_type",
      "deleted_at",
      "space_id",
      "project_id",
      "fts",
      "public_token",
    ]) {
      expect(cols).not.toContain(internal);
    }
  });
});

describe("findPublicDocumentBySlug — WHERE clause includes the Space audience fence", () => {
  it("excludes a Document in an internal-audience Space (negative: audience 'internal' is not in the allowed set)", async () => {
    const wheres: SQL[] = [];
    const db = makeDb([], wheres, []);
    await findPublicDocumentBySlug(db, ORG, SLUG);
    const { text } = renderWhere(wheres[0]!);
    expect(text).toContain('"kb_spaces"."audience" in');
    expect(text).not.toContain("internal");
  });

  it("admits a Document in a public-audience Space (positive: 'public' and 'mixed' are the only allowed values)", async () => {
    const wheres: SQL[] = [];
    const db = makeDb([], wheres, []);
    await findPublicDocumentBySlug(db, ORG, SLUG);
    const { params } = renderWhere(wheres[0]!);
    expect(params).toContain("public");
    expect(params).toContain("mixed");
  });
});

describe("findPublicDocumentBySlug — projection matches the PublicDocumentDetail contract", () => {
  it("selects exactly the detail fields, so no internal column is exposed", async () => {
    const projections: unknown[] = [];
    const db = makeDb([], [], projections);
    await findPublicDocumentBySlug(db, ORG, SLUG);
    expect(projectionKeys(projections[0])).toEqual([
      "id",
      "title",
      "slug",
      "excerpt",
      "content",
      "categoryId",
      "categoryName",
      "categorySlug",
      "views",
      "helpfulCount",
      "notHelpfulCount",
      "tags",
      "seoTitle",
      "seoDescription",
      "publishedAt",
      "updatedAt",
    ]);
  });

  it("maps the content key to the content_text column, not the jsonb content column", async () => {
    const projections: unknown[] = [];
    const db = makeDb([], [], projections);
    await findPublicDocumentBySlug(db, ORG, SLUG);
    const proj = projections[0];
    if (typeof proj !== "object" || proj === null) throw new Error("no projection");
    expect(columnName(Reflect.get(proj, "content"))).toBe("content_text");
  });
});

describe("findPublicDocumentIdBySlug — selects only the id for feedback target resolution", () => {
  it("selects only the id field, so no article content is fetched for a feedback lookup", async () => {
    const projections: unknown[] = [];
    const db = makeDb([], [], projections);
    await findPublicDocumentIdBySlug(db, ORG, SLUG);
    expect(projectionKeys(projections[0])).toEqual(["id"]);
  });

  it("includes the Space audience fence in the WHERE clause (negative: 'internal' not admitted)", async () => {
    const wheres: SQL[] = [];
    const db = makeDb([], wheres, []);
    await findPublicDocumentIdBySlug(db, ORG, SLUG);
    const { text } = renderWhere(wheres[0]!);
    expect(text).toContain('"kb_spaces"."audience" in');
    expect(text).not.toContain("internal");
  });

  it("includes the Space audience fence in the WHERE clause (positive: 'public' and 'mixed' are admitted)", async () => {
    const wheres: SQL[] = [];
    const db = makeDb([], wheres, []);
    await findPublicDocumentIdBySlug(db, ORG, SLUG);
    const { params } = renderWhere(wheres[0]!);
    expect(params).toContain("public");
    expect(params).toContain("mixed");
  });
});
