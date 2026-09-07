import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { chatUserPresence } from "../../../db/schema";

const INDEX_NAME = "uniq_chat_presence_org_membership";
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "..", "migrations");

/** Line and block comments are stripped first: 1054's own header names the index. */
function stripSqlComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

type IndexState = { exists: boolean; partial: boolean; createdBy: string };

/**
 * Replays the journal in applied order and returns the surviving definition of
 * the index — the state a database bootstrapped to head actually ends in.
 */
function replayIndexState(): IndexState | null {
  const journal: { entries: Array<{ when: number; tag: string }> } = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  );
  const ordered = [...journal.entries].sort((a, b) => a.when - b.when);
  const create = new RegExp(
    String.raw`CREATE\s+UNIQUE\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?${INDEX_NAME}"?`,
    "i",
  );
  const drop = new RegExp(
    String.raw`DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?"?${INDEX_NAME}"?`,
    "i",
  );
  const rename = new RegExp(String.raw`ALTER\s+INDEX\s+[^;]*RENAME\s+TO\s+"?${INDEX_NAME}"?`, "i");

  let state: IndexState | null = null;
  for (const entry of ordered) {
    const raw = readFileSync(join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf8");
    for (const chunk of raw.split("--> statement-breakpoint")) {
      const statement = stripSqlComments(chunk);
      if (drop.test(statement)) state = null;
      if (rename.test(statement)) state = { exists: true, partial: false, createdBy: entry.tag };
      if (create.test(statement)) {
        // `WHERE` after the column list is the arbiter-defeating predicate.
        const partial = /\)\s*WHERE\s/i.test(statement);
        state = { exists: true, partial, createdBy: entry.tag };
      }
    }
  }
  return state;
}

describe("chat presence conflict target — migration corpus", () => {
  it("declares the index unique and TOTAL, and membership_id NOT NULL", () => {
    const config = getTableConfig(chatUserPresence);
    const declared = config.indexes.find(
      (index) => (index as unknown as { config: { name: string } }).config.name === INDEX_NAME,
    );
    const shape = (declared as unknown as { config: { unique?: boolean; where?: unknown } } | undefined)
      ?.config;

    expect(shape).toBeDefined();
    expect(shape?.unique).toBe(true);
    // No `.where()`: a bare ON CONFLICT target is only legal against a total index.
    expect(shape?.where).toBeUndefined();
    expect(config.columns.find((column) => column.name === "membership_id")?.notNull).toBe(true);
  });

  it("the surviving journalled definition is TOTAL, so head agrees with the declaration", () => {
    const state = replayIndexState();

    expect(state).not.toBeNull();
    expect(state?.exists).toBe(true);
    // Red before migration 1054: 0713 is the only creator and it creates it partial.
    expect({ createdBy: state?.createdBy, partial: state?.partial }).toEqual({
      createdBy: state?.createdBy,
      partial: false,
    });
  });

  it("proves the replay can see a partial creation at all — 0713 really created one", () => {
    const raw = stripSqlComments(
      readFileSync(join(MIGRATIONS_DIR, "0713_chat_presence_membership_backfill.sql"), "utf8"),
    );
    const statement = raw
      .split("--> statement-breakpoint")
      .find((chunk) => new RegExp(String.raw`CREATE\s+UNIQUE\s+INDEX[^;]*${INDEX_NAME}`, "i").test(chunk));

    expect(statement).toBeDefined();
    expect(/\)\s*WHERE\s/i.test(statement ?? "")).toBe(true);
  });
});
