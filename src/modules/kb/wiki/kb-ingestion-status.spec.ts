import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { KbSourcesService } from "./kb-sources.service";
import { kbPageIngestionStatusSchema } from "./dto/kb-sources.schemas";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const auth = {
  assertPageAccess: jest.fn(),
};

const dialect = new PgDialect();
const ORG = "org-kb-1";

const USER = {
  userId: "user-1",
  orgId: ORG,
  isOrgOwner: false,
} as unknown as CurrentUserContext;

interface Capture {
  projections: Array<Record<string, unknown>>;
  conditions: SQL[];
  orderBys: unknown[][];
  limits: number[];
}

function makeDb(rows: Record<string, unknown>[]): { db: Db; capture: Capture } {
  const capture: Capture = { projections: [], conditions: [], orderBys: [], limits: [] };
  const limit = async (n: number) => {
    capture.limits.push(n);
    return rows;
  };
  const db = {
    select: (projection: Record<string, unknown>) => {
      capture.projections.push(projection);
      return {
        from: () => ({
          where: (condition: SQL) => {
            capture.conditions.push(condition);
            return {
              limit,
              orderBy: (...columns: unknown[]) => {
                capture.orderBys.push(columns);
                return { limit };
              },
            };
          },
        }),
      };
    },
  } as unknown as Db;
  return { db, capture };
}

function service(db: Db): KbSourcesService {
  return new KbSourcesService(
    db,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    auth as never,
    {} as never,
  );
}

function params(condition: SQL | undefined): unknown[] {
  if (!condition) throw new Error("expected a rendered where clause");
  return dialect.sqlToQuery(condition).params;
}

function renderedSql(condition: SQL | undefined): string {
  if (!condition) throw new Error("expected a rendered where clause");
  return dialect.sqlToQuery(condition).sql;
}

const LIST_ITEM_KEYS = [
  "id",
  "kind",
  "title",
  "mimeType",
  "fileSize",
  "fileUrl",
  "status",
  "chunkCount",
  "errorMessage",
  "spaceId",
  "createdById",
  "createdAt",
];

describe("GET /kb/sources/:sourceId", () => {
  beforeEach(() => {
    auth.assertPageAccess.mockClear();
  });

  it("binds the org alongside the id, so a cross-tenant source cannot be read", async () => {
    const { db, capture } = makeDb([{ id: 7 }]);

    await service(db).get(ORG, 7);

    expect(params(capture.conditions[0])).toEqual([7, ORG]);
    expect(renderedSql(capture.conditions[0])).toContain('"deleted_at" is null');
  });

  it("404s rather than 403s when the row belongs to another tenant", async () => {
    const { db } = makeDb([]);

    await expect(service(db).get(ORG, 999)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("projects exactly the columns the list already exposes", async () => {
    const { db, capture } = makeDb([{ id: 7 }]);

    await service(db).get(ORG, 7);

    expect(Object.keys(capture.projections[0] ?? {})).toEqual(LIST_ITEM_KEYS);
  });

  it("reads one row, not a page", async () => {
    const { db, capture } = makeDb([{ id: 7 }]);

    await service(db).get(ORG, 7);

    expect(capture.limits).toEqual([1]);
  });
});

describe("GET /kb/pages/:pageId/indexing-status", () => {
  beforeEach(() => {
    auth.assertPageAccess.mockReset();
    auth.assertPageAccess.mockResolvedValue({
      orgId: ORG,
      pageId: 42,
      action: "view",
      via: "admin",
    });
  });

  it("asserts page visibility before it reads any outbox row", async () => {
    const { db, capture } = makeDb([]);
    auth.assertPageAccess.mockRejectedValueOnce(new NotFoundException("Page not found"));

    await expect(service(db).pageIngestionStatus(USER, 42)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(capture.conditions).toHaveLength(0);
  });

  it("asks the canonical authorization seam rather than the retired page-access helper", async () => {
    const { db } = makeDb([]);

    await service(db).pageIngestionStatus(USER, 42);

    expect(auth.assertPageAccess).toHaveBeenCalledWith(USER, 42, "view");
  });

  it("binds tenant, aggregate and event type — not the page id alone", async () => {
    const { db, capture } = makeDb([]);

    await service(db).pageIngestionStatus(USER, 42);

    expect(params(capture.conditions[0])).toEqual([ORG, "kb_page", "42", "kb.content.index"]);
  });

  it("takes the newest event by aggregate version, one row", async () => {
    const { db, capture } = makeDb([]);

    await service(db).pageIngestionStatus(USER, 42);

    expect(capture.orderBys[0]).toHaveLength(1);
    expect(renderedSql(capture.orderBys[0]?.[0] as SQL)).toContain("aggregate_version");
    expect(renderedSql(capture.orderBys[0]?.[0] as SQL)).toContain("desc");
    expect(capture.limits).toEqual([1]);
  });

  it("reports unknown when no event row survives, never a fabricated success", async () => {
    const { db } = makeDb([]);

    const status = await service(db).pageIngestionStatus(USER, 42);

    expect(status).toEqual({
      pageId: 42,
      state: "unknown",
      retryCount: 0,
      occurredAt: null,
      publishedAt: null,
      deadLetteredAt: null,
    });
  });

  it.each([
    ["PENDING", "pending"],
    ["IN_FLIGHT", "in_flight"],
    ["DELIVERED", "indexed"],
    ["DEAD", "failed"],
    ["SUPPRESSED", "suppressed"],
  ])("maps delivery state %s to %s", async (deliveryState, expected) => {
    const { db } = makeDb([
      {
        deliveryState,
        retryCount: 3,
        occurredAt: new Date(1_700_000_000_000),
        publishedAt: null,
        deadLetteredAt: null,
      },
    ]);

    const status = await service(db).pageIngestionStatus(USER, 42);

    expect(status.state).toBe(expected);
    expect(status.retryCount).toBe(3);
  });

  it("carries the retry budget and the dead-letter stamp a caller has to act on", async () => {
    const deadAt = new Date(1_700_000_500_000);
    const { db } = makeDb([
      {
        deliveryState: "DEAD",
        retryCount: 8,
        occurredAt: new Date(1_700_000_000_000),
        publishedAt: null,
        deadLetteredAt: deadAt,
      },
    ]);

    const status = await service(db).pageIngestionStatus(USER, 42);

    expect(status.state).toBe("failed");
    expect(status.retryCount).toBe(8);
    expect(status.deadLetteredAt).toBe(deadAt);
  });

  it("returns a shape the declared response contract accepts, Date fields included", async () => {
    const { db } = makeDb([
      {
        deliveryState: "DELIVERED",
        retryCount: 0,
        occurredAt: new Date(1_700_000_000_000),
        publishedAt: new Date(1_700_000_100_000),
        deadLetteredAt: null,
      },
    ]);

    const status = await service(db).pageIngestionStatus(USER, 42);

    expect(() => kbPageIngestionStatusSchema.parse(status)).not.toThrow();
  });
});
