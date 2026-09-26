import { INestApplication } from "@nestjs/common";
import { getTableName, sql, type SQL, type Table } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "test/helpers/sign-token";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { Db } from "../../../db/drizzle.module";
import { KbIndexingService } from "../retrieval/kb-indexing.service";
import { KbSourcesService } from "./kb-sources.service";

type Row = Record<string, unknown>;

interface FakeDbOptions {
  projects?: Row[];
  page?: Row;
  sources?: Row[];
  outbox?: Row[];
}

interface FakeDb {
  db: Db;
  tables: string[];
  conditions: SQL[];
}

const auth = {
  visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
  assertPageAccess: jest.fn().mockResolvedValue({ orgId: "org-1", pageId: 1, action: "view", via: "admin" }),
};

const dialect = new PgDialect();

function makeDb(options: FakeDbOptions): FakeDb {
  const tables: string[] = [];
  const conditions: SQL[] = [];

  const rowsFor = (table: string): Row[] => {
    if (table === "projects") return options.projects ?? [];
    if (table === "kb_sources") return options.sources ?? [];
    if (table === "outbox_events") return options.outbox ?? [];
    return [];
  };

  const result = (rows: Row[]) => ({
    then: <T>(
      onFulfilled: (value: Row[]) => T,
      onRejected?: (reason: unknown) => T,
    ): Promise<T> => Promise.resolve(rows).then(onFulfilled, onRejected),
    limit: async (): Promise<Row[]> => rows,
    orderBy: () => ({ limit: async (): Promise<Row[]> => rows }),
  });

  const db = {
    select: () => ({
      from: (table: Table) => {
        const name = getTableName(table);
        tables.push(name);
        const chain = {
          innerJoin: () => chain,
          where: (condition: SQL) => {
            conditions.push(condition);
            return result(rowsFor(name));
          },
        };
        return chain;
      },
    }),
    query: {
      kbPages: {
        findFirst: async (): Promise<Row | undefined> => options.page,
      },
    },
  } as unknown as Db;

  return { db, tables, conditions };
}

function makeService(db: Db): KbSourcesService {
  return new KbSourcesService(
    db,
    {} as never,
    {} as never,
    {} as never,
    auth as never,
    {} as never,
    {} as never,
  );
}

const SOURCE_ROW: Row = {
  id: 7,
  kind: "file",
  title: "Employee handbook.pdf",
  mimeType: "application/pdf",
  fileSize: 1024,
  fileUrl: "kb-sources/org_1/handbook.pdf",
  status: "ready",
  chunkCount: 12,
  errorMessage: null,
  spaceId: 3,
  createdAt: new Date("2026-02-01T09:00:00.000Z"),
};

describe("KB ingestion status over HTTP (e2e)", () => {
  let app: INestApplication;
  let backing: KbSourcesService;

  const delegate = {
    get: (orgId: string, sourceId: number) => backing.get(orgId, sourceId),
    pageIngestionStatus: (user: CurrentUserContext, pageId: number) =>
      backing.pageIngestionStatus(user, pageId),
  };

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [
        { provide: KbSourcesService, useValue: delegate },
        { provide: KbIndexingService, useValue: {} },
      ],
    });
  });

  afterAll(async () => app.close());

  async function reader(): Promise<string> {
    return signToken({ permissions: ["kb:pages:view"], enabledModules: ["kb"] });
  }

  function install(options: FakeDbOptions): FakeDb {
    const fake = makeDb(options);
    backing = makeService(fake.db);
    return fake;
  }

  function call(token: string, path: string): request.Test {
    return request(app.getHttpServer()).get(path).set("Authorization", `Bearer ${token}`);
  }

  const routes: ReadonlyArray<string> = [
    "/kb/sources/7",
    "/kb/pages/1/indexing-status",
  ];

  it.each(routes)("401 on GET %s without a token", async (path) => {
    install({});
    const res = await request(app.getHttpServer()).get(path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it.each(routes)("403 on GET %s without kb:pages:view", async (path) => {
    const fake = install({});
    const token = await signToken({ permissions: [], enabledModules: ["kb"] });
    const res = await call(token, path);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
    expect(fake.tables).toEqual([]);
  });

  it("200 on GET /kb/sources/:sourceId for a source in the caller's own tenant", async () => {
    install({ sources: [SOURCE_ROW] });
    const token = await reader();

    const res = await call(token, "/kb/sources/7");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 7, status: "ready", chunkCount: 12, spaceId: 3 });
  });

  it("404 — never 403 — on GET /kb/sources/:sourceId for another tenant's or an unknown id", async () => {
    const fake = install({ sources: [] });
    const token = await reader();

    const res = await call(token, "/kb/sources/999");

    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
    expect(res.body).toMatchObject({ code: "NOT_FOUND" });
    expect(dialect.sqlToQuery(fake.conditions[0]).params).toEqual([999, "org_1"]);
  });

  it("400 on GET /kb/sources/:sourceId when the id is not a positive integer", async () => {
    const fake = install({});
    const token = await reader();

    const res = await call(token, "/kb/sources/abc");

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(fake.tables).toEqual([]);
  });

  it("404 on GET /kb/pages/:pageId/indexing-status for a page the caller cannot see, with no outbox row read", async () => {
    const fake = install({ outbox: [{ deliveryState: "DEAD", retryCount: 8 }] });
    const token = await reader();

    const res = await call(token, "/kb/pages/1/indexing-status");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "NOT_FOUND", message: "Page not found" });
    expect(fake.tables).not.toContain("outbox_events");
  });

  it("200 with state unknown when the page is visible and no indexing event survives", async () => {
    install({ page: { id: 1 }, outbox: [] });
    const token = await reader();

    const res = await call(token, "/kb/pages/1/indexing-status");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      pageId: 1,
      state: "unknown",
      retryCount: 0,
      occurredAt: null,
      publishedAt: null,
      deadLetteredAt: null,
    });
  });

  it("200 reporting the dead-lettered attempt a caller has to act on", async () => {
    const deadAt = new Date("2026-02-01T10:00:00.000Z");
    const fake = install({
      page: { id: 1 },
      outbox: [
        {
          deliveryState: "DEAD",
          retryCount: 8,
          occurredAt: new Date("2026-02-01T09:00:00.000Z"),
          publishedAt: null,
          deadLetteredAt: deadAt,
        },
      ],
    });
    const token = await reader();

    const res = await call(token, "/kb/pages/1/indexing-status");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      pageId: 1,
      state: "failed",
      retryCount: 8,
      deadLetteredAt: deadAt.toISOString(),
    });
    expect(fake.tables).toEqual(["projects", "outbox_events"]);
  });
});
