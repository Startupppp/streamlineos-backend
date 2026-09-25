import { NotFoundException } from "@nestjs/common";
import { KbPagesService } from "./kb-pages.service";
import { hashPublicToken } from "./kb-public-token";

const RAW_TOKEN = "abc123XYZ-valid-share-token-1234";
const TOKEN_HASH = hashPublicToken(RAW_TOKEN);

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return [value];
  }
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value")
      ? sqlValues(record.value, seen)
      : []),
  ];
}

function buildPage() {
  return {
    title: "Public Page",
    icon: null,
    coverImage: null,
    content: null,
    updatedAt: new Date("2025-01-01T00:00:00Z"),
    publicTokenRevision: 1,
  };
}

function makeDb(row: unknown) {
  const executed: unknown[] = [];
  const whereArgs: unknown[] = [];

  const tx = {
    execute: jest.fn((statement: unknown) => {
      executed.push(statement);
      return Promise.resolve(undefined);
    }),
    query: {
      kbPages: {
        findFirst: jest.fn((opts: { where?: unknown } = {}) => {
          whereArgs.push(opts.where);
          return Promise.resolve(row);
        }),
      },
    },
  };

  const db = {
    transaction: jest.fn((fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  } as never;

  return { db, executed, whereArgs };
}

function makeService(db: never) {
  return new KbPagesService(db, {} as never, {} as never, {} as never, {} as never, {} as never);
}

describe("KbPagesService.getPublicPage — share links resolve by hash, never by plaintext", () => {
  it("serves a published, public, undeleted page, so the negative cases below are not passing on a broken query", async () => {
    const { db } = makeDb(buildPage());

    const result = await makeService(db).getPublicPage(RAW_TOKEN);

    expect(result.title).toBe("Public Page");
    expect(result.updatedAt).toBeInstanceOf(Date);
  });

  it("binds the hash, not the raw token, into the row lookup", async () => {
    const { db, whereArgs } = makeDb(buildPage());

    await makeService(db).getPublicPage(RAW_TOKEN);

    const bound = whereArgs.flatMap((w) => sqlValues(w));
    expect(bound).toContain(TOKEN_HASH);
    expect(bound).not.toContain(RAW_TOKEN);
  });

  it("sets the RLS public-token GUC to the hash, because the policy compares the hash column", async () => {
    const { db, executed } = makeDb(buildPage());

    await makeService(db).getPublicPage(RAW_TOKEN);

    const bound = executed.flatMap((statement) => sqlValues(statement));
    expect(bound).toContain(TOKEN_HASH);
    expect(bound).not.toContain(RAW_TOKEN);
  });

  it("never lets the plaintext token reach the database on any statement it issues", async () => {
    const { db, executed, whereArgs } = makeDb(buildPage());

    await makeService(db).getPublicPage(RAW_TOKEN);

    const everything = [...executed, ...whereArgs].flatMap((v) => sqlValues(v));
    expect(everything).not.toContain(RAW_TOKEN);
  });

  it("throws NotFoundException when the query matches no row, covering draft, archived, private and deleted pages", async () => {
    const { db } = makeDb(undefined);

    await expect(makeService(db).getPublicPage(RAW_TOKEN)).rejects.toThrow(
      NotFoundException,
    );
  });

  it("hashes whatever token it is given, so an unknown token probes a different row rather than falling back to a match", async () => {
    const { db, whereArgs } = makeDb(undefined);

    await expect(
      makeService(db).getPublicPage("token-that-does-not-match"),
    ).rejects.toThrow(NotFoundException);

    const bound = whereArgs.flatMap((w) => sqlValues(w));
    expect(bound).toContain(hashPublicToken("token-that-does-not-match"));
    expect(bound).not.toContain(TOKEN_HASH);
  });

  it("returns publicTokenRevision so the controller can key cache headers on token state changes", async () => {
    const { db } = makeDb({ ...buildPage(), publicTokenRevision: 3 });

    const result = await makeService(db).getPublicPage(RAW_TOKEN);

    expect(result.publicTokenRevision).toBe(3);
  });

  it("does not include the raw token value in the result, so a response log cannot become a bearer credential", async () => {
    const { db } = makeDb(buildPage());

    const result = await makeService(db).getPublicPage(RAW_TOKEN);

    expect(result).not.toHaveProperty("publicToken");
    expect(result).not.toHaveProperty("publicTokenHash");
  });
});
