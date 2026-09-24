import { decodeCursor } from "../../../common/pagination/cursor";
import { KbSourcesService } from "./kb-sources.service";
import type { Db } from "../../../db/drizzle.module";
import { PgDialect } from "drizzle-orm/pg-core";
import { kbSources } from "../../../db/schema";
import { keysetBeforeMicros } from "../../../common/pagination/keyset";
import type { KbSourcesListQuery } from "./dto/kb-sources.schemas";

const ORG = "org-sources-cursor";
const LIMIT = 2;

function sourceRow(id: number, micros: string) {
  return {
    id,
    kind: "note",
    title: `Source ${id}`,
    mimeType: null,
    fileSize: null,
    fileUrl: null,
    status: "ready",
    chunkCount: 1,
    errorMessage: null,
    spaceId: null,
    createdAt: new Date(`${micros.slice(0, 23)}Z`),
    createdAtMicros: micros,
  };
}

function makeService(sourceRows: unknown[]) {
  const selectProjections: unknown[] = [];
  const chain = (rows: unknown[]): object =>
    Object.assign(Promise.resolve(rows), {
      limit: jest.fn(() => chain(rows)),
      orderBy: jest.fn(() => chain(rows)),
    });

  const db = {
    select: jest.fn().mockImplementation((projection: unknown) => {
      selectProjections.push(projection);
      return {
        from: jest.fn().mockReturnValue({
          where: jest.fn(() => chain(sourceRows)),
        }),
      };
    }),
  } as unknown as Db;

  const svc = new KbSourcesService(
    db,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
  );

  return { svc, selectProjections };
}

describe("KbSourcesService.list — cursor precision", () => {
  const query = { limit: LIMIT } as KbSourcesListQuery;

  it("carries full microsecond precision in nextCursor, so a row inside the sub-millisecond gap is not skipped", async () => {
    const rows = [
      sourceRow(3, "2026-03-01T10:00:00.500900"),
      sourceRow(2, "2026-03-01T10:00:00.500400"),
      sourceRow(1, "2026-03-01T10:00:00.500100"),
    ];
    const { svc } = makeService(rows);

    const page = await svc.list(ORG, query);

    expect(page.pagination.hasMore).toBe(true);
    const position = decodeCursor(page.pagination.nextCursor);
    expect(position).not.toBeNull();
    expect(position?.sortValue).toBe("2026-03-01T10:00:00.500400");
  });

  it("does not truncate the boundary to milliseconds, which would skip every row in the same millisecond", async () => {
    const rows = [
      sourceRow(3, "2026-03-01T10:00:00.500900"),
      sourceRow(2, "2026-03-01T10:00:00.500400"),
      sourceRow(1, "2026-03-01T10:00:00.500100"),
    ];
    const { svc } = makeService(rows);

    const page = await svc.list(ORG, query);
    const position = decodeCursor(page.pagination.nextCursor);

    expect(position?.sortValue).not.toBe("2026-03-01T10:00:00.500Z");
    expect(position?.sortValue).not.toBe("2026-03-01T10:00:00.500000");
  });

  it("projects the boundary column at microsecond precision rather than relying on the driver Date", async () => {
    const rows = [sourceRow(1, "2026-03-01T10:00:00.500100")];
    const { svc, selectProjections } = makeService(rows);

    await svc.list(ORG, query);

    const projection = selectProjections[0] as Record<string, unknown>;
    expect(projection).toHaveProperty("createdAtMicros");
  });

  it("omits the internal cursor column from the returned rows, so it never becomes part of the response contract", async () => {
    const rows = [sourceRow(1, "2026-03-01T10:00:00.500100")];
    const { svc } = makeService(rows);

    const page = await svc.list(ORG, query);

    expect(page.data).toHaveLength(1);
    expect(page.data[0]).not.toHaveProperty("createdAtMicros");
    expect(page.data[0]).toHaveProperty("title", "Source 1");
  });

  it("builds a '<' predicate matching DESC sort order, so pagination moves toward older rows", () => {
    const clause = keysetBeforeMicros(kbSources.createdAt, kbSources.id, {
      sortValue: "2026-03-01T10:00:00.500400",
      id: 5,
    });
    const { sql: rendered } = new PgDialect().sqlToQuery(clause);
    expect(rendered).toContain("<");
    expect(rendered).not.toContain(">");
  });
});
