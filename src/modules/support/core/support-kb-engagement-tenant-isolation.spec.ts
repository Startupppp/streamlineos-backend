import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { getTableName, type SQL, type Table } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import type { StorageService } from "../../storage/storage.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import {
  actingMembershipId,
  humanSessionPrincipal,
  principalIsOrgOwner,
} from "../../../common/auth/principal";
import { SupportKbEngagementService } from "./support-kb-engagement.service";

type Row = Record<string, unknown>;
type Store = Map<string, Row[]>;

type PredicateToken =
  | { kind: "column"; name: string }
  | { kind: "param"; value: unknown }
  | { kind: "text"; text: string };

interface Comparison {
  column: string;
  operator: "eq" | "in" | "isNull" | "isNotNull";
  values: unknown[];
}

function tokenize(node: unknown, out: PredicateToken[]): PredicateToken[] {
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
  if (Object.prototype.hasOwnProperty.call(node, "value"))
    out.push({ kind: "param", value });
  return out;
}

function parseConjunction(tokens: PredicateToken[]): Comparison[] {
  const out: Comparison[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) continue;
    if (token.kind === "text" && / or /.test(token.text))
      throw new Error(`isolation double: disjunctions are not interpreted (${token.text})`);
    if (token.kind !== "column") continue;

    const operator = tokens[i + 1];
    if (operator === undefined || operator.kind !== "text")
      throw new Error(`isolation double: no operator after column ${token.name}`);

    const values: unknown[] = [];
    let cursor = i + 2;
    for (let next = tokens[cursor]; next !== undefined && next.kind === "param"; next = tokens[cursor]) {
      values.push(next.value);
      cursor += 1;
    }

    const symbol = operator.text.trim();
    if (symbol === "=") out.push({ column: token.name, operator: "eq", values: values.slice(0, 1) });
    else if (symbol === "in") out.push({ column: token.name, operator: "in", values });
    else if (symbol === "is null") out.push({ column: token.name, operator: "isNull", values: [] });
    else if (symbol === "is not null") out.push({ column: token.name, operator: "isNotNull", values: [] });
    else throw new Error(`isolation double: unsupported operator "${symbol}"`);
    i = cursor - 1;
  }
  return out;
}

function camelCase(column: string): string {
  return column.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function rowMatches(row: Row, comparisons: Comparison[], ignoreTenantPredicate: boolean): boolean {
  return comparisons.every((comparison) => {
    if (ignoreTenantPredicate && comparison.column === "org_id") return true;
    const actual = row[camelCase(comparison.column)];
    if (comparison.operator === "isNull") return actual === null || actual === undefined;
    if (comparison.operator === "isNotNull") return actual !== null && actual !== undefined;
    if (comparison.operator === "eq") return actual === comparison.values[0];
    return comparison.values.includes(actual);
  });
}

function project(row: Row, projection: Record<string, unknown>): Row {
  const out: Row = {};
  for (const [alias, column] of Object.entries(projection)) {
    const name = column === null || typeof column !== "object" ? undefined : Reflect.get(column, "name");
    out[alias] = typeof name === "string" ? row[camelCase(name)] : undefined;
  }
  return out;
}

function select(store: Store, table: Table, condition: SQL | undefined, ignore: boolean): Row[] {
  const rows = store.get(getTableName(table)) ?? [];
  if (condition === undefined) return [...rows];
  return rows.filter((row) => rowMatches(row, parseConjunction(tokenize(condition, [])), ignore));
}

function makeDb(store: Store, ignoreTenantPredicate = false): Db {
  let nextId = 900;

  const selectBuilder = (projection?: Record<string, unknown>) => {
    let table: Table | null = null;
    let condition: SQL | undefined;
    const resolve = (): Row[] => {
      if (table === null) return [];
      const rows = select(store, table, condition, ignoreTenantPredicate);
      if (projection === undefined) return rows;
      return rows.map((row) => project(row, projection));
    };
    const builder = {
      from: (source: Table) => {
        table = source;
        return builder;
      },
      leftJoin: () => builder,
      innerJoin: () => builder,
      where: (predicate: SQL) => {
        condition = predicate;
        return builder;
      },
      orderBy: () => builder,
      limit: (count: number) => Promise.resolve(resolve().slice(0, count)),
      then: (onFulfilled?: (rows: Row[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(resolve()).then(onFulfilled, onRejected),
    };
    return builder;
  };

  const deleteBuilder = (table: Table) => {
    let condition: SQL | undefined;
    const apply = (): Row[] => {
      const name = getTableName(table);
      const rows = store.get(name) ?? [];
      const removed = select(store, table, condition, ignoreTenantPredicate);
      store.set(
        name,
        rows.filter((row) => !removed.includes(row)),
      );
      return removed;
    };
    const builder = {
      where: (predicate: SQL) => {
        condition = predicate;
        return builder;
      },
      returning: () => Promise.resolve(apply()),
    };
    return builder;
  };

  const insertBuilder = (table: Table) => {
    let pending: Row[] = [];
    const apply = (): Row[] => {
      const name = getTableName(table);
      nextId += 1;
      const inserted = pending.map((row, index) => ({ id: nextId + index, ...row }));
      store.set(name, [...(store.get(name) ?? []), ...inserted]);
      return inserted;
    };
    const builder = {
      values: (rows: Row | Row[]) => {
        pending = Array.isArray(rows) ? rows : [rows];
        return builder;
      },
      returning: () => Promise.resolve(apply()),
    };
    return builder;
  };

  const findFirst = (name: string) => async ({ where }: { where?: SQL }): Promise<Row | undefined> => {
    const rows = store.get(name) ?? [];
    if (where === undefined) return rows[0];
    return rows.find((row) => rowMatches(row, parseConjunction(tokenize(where, [])), ignoreTenantPredicate));
  };

  return {
    select: jest.fn(selectBuilder),
    delete: jest.fn(deleteBuilder),
    insert: jest.fn(insertBuilder),
    query: {
      kbPages: { findFirst: jest.fn(findFirst("kb_pages")) },
      users: { findFirst: jest.fn(findFirst("users")) },
    },
  } as unknown as Db;
}

const ORG_A = "org-victim";
const ORG_B = "org-attacker";

function seed(): Store {
  return new Map<string, Row[]>([
    [
      "kb_pages",
      [
        { id: 10, orgId: ORG_A, title: "Production key rotation", contentType: "support_article", deletedAt: null, archivedAt: null },
        { id: 20, orgId: ORG_B, title: "Attacker onboarding", contentType: "support_article", deletedAt: null, archivedAt: null },
        { id: 30, orgId: ORG_A, title: "Internal wiki runbook", contentType: "note", deletedAt: null, archivedAt: null },
        { id: 40, orgId: ORG_A, title: "Deleted article", contentType: "support_article", deletedAt: new Date("2026-01-01T00:00:00Z"), archivedAt: null },
      ],
    ],
    [
      "kb_page_comments",
      [
        {
          id: 100,
          orgId: ORG_A,
          pageId: 10,
          authorId: "user-a",
          content: "Rotate the prod signing key every Friday.",
        },
      ],
    ],
    [
      "kb_page_attachments",
      [
        {
          id: 1,
          orgId: ORG_A,
          pageId: 10,
          deletedAt: null,
          fileKey: "org-victim/kb-attachments/prod-runbook.pdf",
          fileName: "prod-runbook.pdf",
          mimeType: "application/pdf",
        },
      ],
    ],
    ["kb_page_feedback", [{ id: 500, orgId: ORG_A, pageId: 10, helpful: true }]],
    ["users", [{ id: "user-b", name: "Mallory", image: null }]],
  ]);
}

function attackerActor(): CurrentUserContext {
  return {
    userId: "user-b",
    orgId: ORG_B,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "session-b",
    tokenScopes: null,
    principal: humanSessionPrincipal(77, false),
  };
}

type StorageDouble = Pick<StorageService, "getFileUrl">;

function makeStorage(): { storage: StorageService; getFileUrl: jest.Mock } {
  const getFileUrl = jest
    .fn()
    .mockResolvedValue("https://signed.example.com/prod-runbook.pdf");
  const double: StorageDouble = { getFileUrl };
  return { storage: double as StorageService, getFileUrl };
}

function expectNotFound(error: unknown): void {
  expect(error).toBeInstanceOf(NotFoundException);
  expect(error).not.toBeInstanceOf(ForbiddenException);
  if (!(error instanceof NotFoundException)) return;
  expect(error.getStatus()).toBe(404);
}

async function capture(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected the call to reject, but it resolved");
}

describe("SupportKbEngagementService — cross-tenant isolation", () => {
  const actor = attackerActor();

  it("probes with a non-owner actor carrying a membership id", () => {
    expect(principalIsOrgOwner(actor.principal)).toBe(false);
    expect(actor.isOrgOwner).toBe(false);
    expect(actingMembershipId(actor.principal)).toBe(77);
  });

  describe("reads", () => {
    it("getAttachmentDownloadUrl denies org B and answers 404, never 403", async () => {
      const store = seed();
      const { storage, getFileUrl } = makeStorage();
      const service = new SupportKbEngagementService(makeDb(store), storage);

      const error = await capture(() => service.getAttachmentDownloadUrl(actor.orgId, 10, 1));

      expectNotFound(error);
      expect(getFileUrl).not.toHaveBeenCalled();
    });

    it("getAttachmentDownloadUrl serves the owning org — control", async () => {
      const { storage, getFileUrl } = makeStorage();
      const service = new SupportKbEngagementService(makeDb(seed()), storage);

      const result = await service.getAttachmentDownloadUrl(ORG_A, 10, 1);

      expect(result.fileName).toBe("prod-runbook.pdf");
      expect(getFileUrl).toHaveBeenCalledWith(
        ORG_A,
        "org-victim/kb-attachments/prod-runbook.pdf",
        3600,
      );
    });

    it("BITE — neutering the tenant predicate leaks org A's attachment to org B", async () => {
      const { storage, getFileUrl } = makeStorage();
      const service = new SupportKbEngagementService(
        makeDb(seed(), true),
        storage,
      );

      const leaked = await service.getAttachmentDownloadUrl(actor.orgId, 10, 1);

      expect(leaked.fileName).toBe("prod-runbook.pdf");
      expect(getFileUrl).toHaveBeenCalledWith(
        ORG_B,
        "org-victim/kb-attachments/prod-runbook.pdf",
        3600,
      );
    });

    it("listComments / listFeedback / listAttachments deny org B with 404", async () => {
      const service = new SupportKbEngagementService(
        makeDb(seed()),
        makeStorage().storage,
      );

      for (const call of [
        () => service.listComments(actor.orgId, 10),
        () => service.listFeedback(actor.orgId, 10),
        () => service.listAttachments(actor.orgId, 10),
      ]) {
        expectNotFound(await capture(call));
      }
    });

    it("listComments serves the owning org — control", async () => {
      const service = new SupportKbEngagementService(
        makeDb(seed()),
        makeStorage().storage,
      );

      const rows = await service.listComments(ORG_A, 10);

      expect(rows).toHaveLength(1);
    });

    it("BITE — neutering the tenant predicate leaks org A's comments to org B", async () => {
      const service = new SupportKbEngagementService(
        makeDb(seed(), true),
        makeStorage().storage,
      );

      const leaked = await service.listComments(actor.orgId, 10);

      expect(leaked).toHaveLength(1);
      expect(leaked[0]?.body).toBe("Rotate the prod signing key every Friday.");
    });
  });

  describe("kb_pages holds wiki pages too", () => {
    it("listComments 404s on an internal wiki page in the caller's own org", async () => {
      const service = new SupportKbEngagementService(makeDb(seed()), makeStorage().storage);

      expectNotFound(await capture(() => service.listComments(ORG_A, 30)));
    });

    it("listComments 404s on a soft-deleted support article in the caller's own org", async () => {
      const service = new SupportKbEngagementService(makeDb(seed()), makeStorage().storage);

      expectNotFound(await capture(() => service.listComments(ORG_A, 40)));
    });

    it("listComments serves a live support article in the same org — the two denials above are not vacuous", async () => {
      const service = new SupportKbEngagementService(makeDb(seed()), makeStorage().storage);

      await expect(service.listComments(ORG_A, 10)).resolves.toHaveLength(1);
    });
  });

  describe("mutations", () => {
    it("deleteComment denies org B with 404 and leaves org A's row intact", async () => {
      const store = seed();
      const service = new SupportKbEngagementService(
        makeDb(store),
        makeStorage().storage,
      );

      const error = await capture(() => service.deleteComment(actor.orgId, 10, 100));

      expectNotFound(error);
      expect(store.get("kb_page_comments")).toHaveLength(1);
    });

    it("BITE — neutering the tenant predicate lets org B delete org A's comment", async () => {
      const store = seed();
      const service = new SupportKbEngagementService(
        makeDb(store, true),
        makeStorage().storage,
      );

      await expect(service.deleteComment(actor.orgId, 10, 100)).resolves.toEqual({ success: true });
      expect(store.get("kb_page_comments")).toHaveLength(0);
    });

    it("deleteAttachment denies org B with 404 and leaves org A's row intact", async () => {
      const store = seed();
      const service = new SupportKbEngagementService(
        makeDb(store),
        makeStorage().storage,
      );

      const error = await capture(() => service.deleteAttachment(actor.orgId, 10, 1));

      expectNotFound(error);
      expect(store.get("kb_page_attachments")).toHaveLength(1);
    });

    it("createComment denies org B with 404 and writes nothing", async () => {
      const store = seed();
      const service = new SupportKbEngagementService(
        makeDb(store),
        makeStorage().storage,
      );

      const error = await capture(() =>
        service.createComment(actor.orgId, 10, actor.userId, { body: "ping" }),
      );

      expectNotFound(error);
      expect(store.get("kb_page_comments")).toHaveLength(1);
    });

    it("BITE — neutering the tenant predicate lets org B comment on org A's article", async () => {
      const store = seed();
      const service = new SupportKbEngagementService(
        makeDb(store, true),
        makeStorage().storage,
      );

      await service.createComment(actor.orgId, 10, actor.userId, { body: "ping" });

      expect(store.get("kb_page_comments")).toHaveLength(2);
      expect(store.get("kb_page_comments")?.[1]).toMatchObject({ orgId: ORG_B, pageId: 10 });
    });

    it("createAttachment denies org B with 404 and writes nothing", async () => {
      const store = seed();
      const service = new SupportKbEngagementService(
        makeDb(store),
        makeStorage().storage,
      );

      const error = await capture(() =>
        service.createAttachment(actor.orgId, 10, actor.userId, {
          fileName: "exfil.pdf",
          fileKey: "org-attacker/kb-attachments/exfil.pdf",
          fileSize: 12,
          mimeType: "application/pdf",
        }),
      );

      expectNotFound(error);
      expect(store.get("kb_page_attachments")).toHaveLength(1);
    });
  });
});
