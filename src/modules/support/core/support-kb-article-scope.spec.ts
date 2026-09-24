import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import {
  createArticle,
  deleteArticle,
  getArticle,
  listArticles,
} from "./lib/support-kb-articles";

type Token =
  | { kind: "column"; name: string }
  | { kind: "param"; value: unknown }
  | { kind: "text"; text: string };

function tokenize(node: unknown, out: Token[]): Token[] {
  if (Array.isArray(node)) {
    for (const item of node) tokenize(item, out);
    return out;
  }
  if (node === null || typeof node !== "object") return out;

  const columnName = Reflect.get(node, "name");
  if (typeof columnName === "string" && Reflect.get(node, "table") !== undefined) {
    out.push({ kind: "column", name: columnName });
    return out;
  }

  const chunks = Reflect.get(node, "queryChunks");
  if (Array.isArray(chunks)) return tokenize(chunks, out);

  const value = Reflect.get(node, "value");
  if (node.constructor.name === "StringChunk") {
    out.push({ kind: "text", text: Array.isArray(value) ? value.join("") : String(value) });
    return out;
  }
  if (Object.prototype.hasOwnProperty.call(node, "value")) out.push({ kind: "param", value });
  return out;
}

function render(predicate: unknown): string {
  return tokenize(predicate, [])
    .map((token) => {
      if (token.kind === "column") return `[${token.name}]`;
      if (token.kind === "param") return `{${String(token.value)}}`;
      return token.text;
    })
    .join("");
}

interface Recorder {
  db: Db;
  wheres: unknown[];
  inserted: Record<string, unknown>[];
}

function recordingDb(rows: unknown[] = []): Recorder {
  const wheres: unknown[] = [];
  const inserted: Record<string, unknown>[] = [];

  const chain: Record<string, unknown> = {};
  const self = (): unknown => chain;
  chain.from = self;
  chain.innerJoin = self;
  chain.leftJoin = self;
  chain.orderBy = self;
  chain.where = (predicate: unknown): unknown => {
    wheres.push(predicate);
    return chain;
  };
  chain.limit = (): Promise<unknown[]> => Promise.resolve(rows);
  chain.then = (resolve: (value: unknown[]) => unknown): Promise<unknown> =>
    Promise.resolve(rows).then(resolve);

  interface UpdateChain {
    set: () => UpdateChain;
    where: (predicate: unknown) => UpdateChain;
    returning: () => Promise<unknown[]>;
  }
  const updateChain: UpdateChain = {
    set: () => updateChain,
    where: (predicate: unknown) => {
      wheres.push(predicate);
      return updateChain;
    },
    returning: () => Promise.resolve(rows),
  };

  interface InsertChain {
    values: (values: Record<string, unknown>) => InsertChain;
    onConflictDoNothing: () => Promise<unknown>;
    returning: () => Promise<unknown[]>;
  }
  const insertChain: InsertChain = {
    values: (values: Record<string, unknown>) => {
      inserted.push(values);
      return insertChain;
    },
    onConflictDoNothing: () => Promise.resolve(undefined),
    returning: () => Promise.resolve([{ id: 7 }]),
  };

  const tx = {
    select: () => chain,
    insert: () => insertChain,
    delete: () => ({ where: (): Promise<unknown> => Promise.resolve(undefined) }),
  };

  const db = {
    select: () => chain,
    update: () => updateChain,
    transaction: (cb: (handle: typeof tx) => Promise<unknown>) => cb(tx),
  } as unknown as Db;

  return { db, wheres, inserted };
}

const ORG = "org-support";

describe("support KB reads are scoped to support articles, not every kb_pages row", () => {
  it("listArticles filters content_type AND deleted_at", async () => {
    const { db, wheres } = recordingDb();

    await listArticles(db, ORG, {});

    const predicate = render(wheres[0]);
    expect(predicate).toContain("[content_type] = {support_article}");
    expect(predicate).toContain("[deleted_at] is null");
  });

  it("listArticles still scopes by org — the content_type assertion did not replace the tenant predicate", async () => {
    const { db, wheres } = recordingDb();

    await listArticles(db, ORG, {});

    expect(render(wheres[0])).toContain(`[org_id] = {${ORG}}`);
  });

  it("listArticles maps the article visibility filter onto an allow-list, never admitting a private page", async () => {
    const { db, wheres } = recordingDb();

    await listArticles(db, ORG, { visibility: "internal" });

    const predicate = render(wheres[0]);
    expect(predicate).toContain("[visibility] = {org}");
    expect(predicate).not.toContain("{private}");
  });

  it("listArticles asks for 'public' when the caller asks for public — the allow-list is not a constant", async () => {
    const { db, wheres } = recordingDb();

    await listArticles(db, ORG, { visibility: "public" });

    expect(render(wheres[0])).toContain("[visibility] = {public}");
  });

  it("getArticle filters content_type AND deleted_at", async () => {
    const { db, wheres } = recordingDb([]);

    await expect(getArticle(db, ORG, 10)).rejects.toThrow(NotFoundException);

    const predicate = render(wheres[0]);
    expect(predicate).toContain("[content_type] = {support_article}");
    expect(predicate).toContain("[deleted_at] is null");
  });

  it("deleteArticle soft-deletes the row it matched instead of hard-deleting a kb_pages row", async () => {
    const { db, wheres } = recordingDb([{ id: 10 }]);

    await expect(deleteArticle(db, ORG, 10)).resolves.toEqual({ success: true });

    const predicate = render(wheres[0]);
    expect(predicate).toContain("[content_type] = {support_article}");
    expect(predicate).toContain("[deleted_at] is null");
  });

  it("deleteArticle 404s when the id names a row outside the support-article scope", async () => {
    const { db } = recordingDb([]);

    await expect(deleteArticle(db, ORG, 10)).rejects.toThrow(NotFoundException);
  });
});

describe("support KB writes stamp the row as a support article", () => {
  it("createArticle writes content_type so the article is not indistinguishable from a wiki page", async () => {
    const { db, inserted } = recordingDb([]);

    await createArticle(db, ORG, "user-1", {
      title: "Reset password",
      status: "draft",
      visibility: "internal",
    });

    expect(inserted[0]).toMatchObject({ contentType: "support_article" });
  });

  it("createArticle maps article visibility onto the page domain", async () => {
    const { db, inserted } = recordingDb([]);

    await createArticle(db, ORG, "user-1", {
      title: "Reset password",
      status: "draft",
      visibility: "internal",
    });

    expect(inserted[0]).toMatchObject({ visibility: "org" });
    expect(inserted[0]?.visibility).not.toBe("internal");
  });

  it("createArticle carries 'public' through unchanged — the mapping is not a constant", async () => {
    const { db, inserted } = recordingDb([]);

    await createArticle(db, ORG, "user-1", {
      title: "Status page",
      status: "draft",
      visibility: "public",
    });

    expect(inserted[0]).toMatchObject({ visibility: "public" });
  });

  it("createArticle puts the body in content_text and a document in content", async () => {
    const { db, inserted } = recordingDb([]);

    await createArticle(db, ORG, "user-1", {
      title: "Reset password",
      content: "Open settings.",
      status: "draft",
      visibility: "internal",
    });

    expect(inserted[0]).toMatchObject({ contentText: "Open settings." });
    expect(typeof inserted[0]?.content).toBe("object");
  });
});
