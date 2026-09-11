import { readFileSync } from "node:fs";
import { join } from "node:path";

const BACKEND_ROOT = join(__dirname, "..", "..", "..");
const TAG = "1078_kb_version_append_only";

const up = readFileSync(join(BACKEND_ROOT, "migrations", `${TAG}.sql`), "utf8");
const down = readFileSync(join(BACKEND_ROOT, "migrations", "rollback", `${TAG}.down.sql`), "utf8");

const body = up
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

const journal: { entries: JournalEntry[] } = JSON.parse(
  readFileSync(join(BACKEND_ROOT, "migrations", "meta", "_journal.json"), "utf8"),
);

describe("1078 — kb version tables are append-only at the database boundary", () => {
  it("is registered in the drizzle journal, or db:migrate prints success and never runs it", () => {
    expect(journal.entries.find((e) => e.tag === TAG)).toBeDefined();
  });

  // Global `when` monotonicity belongs to `verify-migration-chain.mjs` check (c),
  // which carries the baseline of adjacent pairs two merged lineages left behind —
  // this journal has fifteen of them, every one listed there. Repeating that check
  // here without the baseline asserted a shape the journal has not had since the
  // lineages were interleaved. What is 1078's own to prove is the condition that
  // strands a migration: a `when` at or below one already in the ledger is skipped
  // forever while `db:migrate` still prints success.
  it("keeps idx and when unique, and puts 1078's when above every entry before it", () => {
    const idxs = journal.entries.map((e) => e.idx);
    expect(new Set(idxs).size).toBe(idxs.length);
    const whens = journal.entries.map((e) => e.when);
    expect(new Set(whens).size).toBe(whens.length);

    const position = journal.entries.findIndex((e) => e.tag === TAG);
    expect(position).toBeGreaterThan(0);
    const mine = journal.entries[position]?.when ?? 0;
    for (const earlier of journal.entries.slice(0, position))
      expect(earlier.when).toBeLessThan(mine);
  });

  it("installs a row-level BEFORE UPDATE OR DELETE trigger on both version tables", () => {
    for (const table of ["kb_page_versions", "kb_article_versions"]) {
      expect(body).toContain(`CREATE TRIGGER ${table}_append_only`);
      expect(body).toContain(`BEFORE UPDATE OR DELETE ON public.${table}`);
    }
    expect(body.match(/FOR EACH ROW EXECUTE FUNCTION/g)).toHaveLength(2);
  });

  it("lets a cascade delete through so page hard-delete and article delete keep working", () => {
    expect(body.match(/pg_trigger_depth\(\) > 1/g)).toHaveLength(2);
    expect(body).toContain("NOT EXISTS (SELECT 1 FROM public.kb_pages WHERE id = OLD.page_id)");
    expect(body).toContain("NOT EXISTS (SELECT 1 FROM public.kb_articles WHERE id = OLD.article_id)");
    expect(body.match(/RETURN OLD;/g)).toHaveLength(2);
  });

  it("locks the substance of a recorded version", () => {
    const immutable = [
      "OLD.org_id",
      "OLD.page_id",
      "OLD.article_id",
      "OLD.version_number",
      "OLD.title",
      "OLD.content",
      "OLD.content_text",
      "OLD.excerpt",
      "OLD.change_summary",
      "OLD.created_at",
    ];
    for (const column of immutable) expect(body).toContain(`${column} `);
  });

  it("never locks author_id or author_membership_id — user deletion and membership revocation redact them", () => {
    expect(body).not.toContain("OLD.author_id");
    expect(body).not.toContain("OLD.author_membership_id");
    expect(body).toContain("SET author_membership_id = author_membership_id");
  });

  it("raises 42501 so a violation is not mistaken for a constraint failure", () => {
    expect(body.match(/USING ERRCODE = '42501'/g)).toHaveLength(5);
  });

  it("blocks TRUNCATE with its own statement-level trigger — a row trigger cannot see it", () => {
    for (const table of ["kb_page_versions", "kb_article_versions"]) {
      expect(body).toContain(`CREATE TRIGGER ${table}_no_truncate`);
      expect(body).toContain(`BEFORE TRUNCATE ON public.${table}`);
    }
    expect(body.match(/FOR EACH STATEMENT EXECUTE FUNCTION app\.prevent_kb_version_truncate/g)).toHaveLength(2);
  });

  it("never puts a statement-breakpoint inside a dollar-quoted body", () => {
    for (const chunk of up.split("--> statement-breakpoint")) {
      const dollars = chunk.match(/\$\$/g) ?? [];
      expect(dollars.length % 2).toBe(0);
    }
  });

  it("sets lock_timeout in both directions and drops everything it created on rollback", () => {
    expect(body).toContain("SET lock_timeout");
    expect(down).toContain("SET lock_timeout");
    expect(down).toContain("DROP TRIGGER IF EXISTS kb_page_versions_append_only");
    expect(down).toContain("DROP TRIGGER IF EXISTS kb_article_versions_append_only");
    expect(down).toContain("DROP FUNCTION IF EXISTS app.prevent_kb_page_version_mutation()");
    expect(down).toContain("DROP FUNCTION IF EXISTS app.prevent_kb_article_version_mutation()");
    expect(down).toContain("DROP TRIGGER IF EXISTS kb_page_versions_no_truncate");
    expect(down).toContain("DROP TRIGGER IF EXISTS kb_article_versions_no_truncate");
    expect(down).toContain("DROP FUNCTION IF EXISTS app.prevent_kb_version_truncate()");
  });
});
