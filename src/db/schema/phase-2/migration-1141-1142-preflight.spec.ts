import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "migrations");
const ROLLBACK_DIR = join(MIGRATIONS_DIR, "rollback");
const META_DIR = join(MIGRATIONS_DIR, "meta");

const TAG_1141 = "1141_projects_pm_workspace_optional";
const TAG_1142 = "1142_fix_requisition_headcount_fk_set_null";
const TAG_1140 = "1140_exit_checklist_ownership";

type JournalEntry = {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
};

type Journal = { version: string; dialect: string; entries: JournalEntry[] };

type ChainEntry = { tag: string; when: number; sha256: string; effective: string };

type Chain = { note?: string; sealedAt?: string; entries: ChainEntry[] };

const journal = JSON.parse(readFileSync(join(META_DIR, "_journal.json"), "utf8")) as Journal;
const chain = JSON.parse(readFileSync(join(META_DIR, "_chain.sha256.json"), "utf8")) as Chain;

const sqlFileTags = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => f.replace(/\.sql$/, ""));

const entryFor = (tag: string): JournalEntry => {
  const found = journal.entries.find((e) => e.tag === tag);
  if (!found) throw new Error(`tag not in journal: ${tag}`);
  return found;
};

const bodyOf = (tag: string): string => readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8");

const stripSqlComments = (sql: string): string =>
  sql
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/--(?!> statement-breakpoint)[^\n]*/, ""))
    .join("\n");

describe("migration 1141/1142 staging preflight", () => {
  describe("journal and file set are in parity", () => {
    it("every .sql file on disk has exactly one journal entry", () => {
      const journalTags = new Set(journal.entries.map((e) => e.tag));
      const unjournalled = sqlFileTags.filter((t) => !journalTags.has(t));
      expect(unjournalled).toEqual([]);
    });

    it("every journal entry has a .sql file on disk", () => {
      const fileTags = new Set(sqlFileTags);
      const fileless = journal.entries.filter((e) => !fileTags.has(e.tag)).map((e) => e.tag);
      expect(fileless).toEqual([]);
    });

    it("the file count and the entry count are the same number", () => {
      expect(journal.entries.length).toBe(sqlFileTags.length);
    });

    it("no two journal entries share an idx", () => {
      const idxs = journal.entries.map((e) => e.idx);
      expect(idxs.length - new Set(idxs).size).toBe(0);
    });

    it("no two journal entries share a tag", () => {
      const tags = journal.entries.map((e) => e.tag);
      expect(tags.length - new Set(tags).size).toBe(0);
    });
  });

  describe("predecessor ordering holds for the two migrations under test", () => {
    it("1141 sits at idx 1029 and 1142 at idx 1030", () => {
      expect(entryFor(TAG_1141).idx).toBe(1029);
      expect(entryFor(TAG_1142).idx).toBe(1030);
    });

    it("1141 when is strictly greater than its predecessor 1140", () => {
      expect(entryFor(TAG_1141).when).toBeGreaterThan(entryFor(TAG_1140).when);
    });

    it("1142 when is strictly greater than 1141 so the pair can only apply in order", () => {
      expect(entryFor(TAG_1142).when).toBeGreaterThan(entryFor(TAG_1141).when);
    });

    it("every migration appended after 1142 remains ordered after the pair", () => {
      const entry1142 = entryFor(TAG_1142);
      const later = journal.entries.filter((entry) => entry.idx > entry1142.idx);
      expect(later.length).toBeGreaterThan(0);
      expect(later.every((entry) => entry.when > entry1142.when)).toBe(true);
    });

    it("when is strictly increasing across the whole journal once sorted by idx", () => {
      const byIdx = [...journal.entries].sort((a, b) => a.idx - b.idx);
      const regressions = byIdx
        .slice(1)
        .filter((entry, i) => entry.when <= byIdx[i].when)
        .map((entry) => entry.tag);
      expect(regressions).toEqual([]);
    });

    it("the only array-order when regression is the adjudicated 0619/0271a pair", () => {
      const regressions = journal.entries
        .slice(1)
        .map((entry, i) => ({ prev: journal.entries[i].tag, next: entry.tag, drop: entry.when < journal.entries[i].when }))
        .filter((r) => r.drop)
        .map((r) => `${r.prev} -> ${r.next}`);
      expect(regressions).toEqual(["0271a_waitlist_admission -> 0619_chain_creates_what_production_has"]);
    });
  });

  describe("1141 is a catalog-only NOT NULL drop with a lock timeout", () => {
    const body = bodyOf(TAG_1141);

    it("sets a lock timeout before touching the table", () => {
      expect(body).toMatch(/SET\s+lock_timeout\s*=\s*'5s'/i);
    });

    it("drops NOT NULL on build.projects.pm_workspace_id", () => {
      expect(stripSqlComments(body)).toMatch(
        /ALTER\s+TABLE\s+"build"\."projects"\s+ALTER\s+COLUMN\s+"pm_workspace_id"\s+DROP\s+NOT\s+NULL/i,
      );
    });

    it("contains no table rewrite verbs so the change stays catalog-only", () => {
      const stripped = stripSqlComments(body);
      expect(stripped).not.toMatch(/\b(UPDATE|INSERT|DELETE|CLUSTER|VACUUM\s+FULL)\b/i);
      expect(stripped).not.toMatch(/\bSET\s+DATA\s+TYPE\b/i);
    });

    it("has a rollback file on disk", () => {
      expect(existsSync(join(ROLLBACK_DIR, `${TAG_1141}.down.sql`))).toBe(true);
    });
  });

  describe("1141 rollback uses the two-step NOT NULL restoration path", () => {
    const down = readFileSync(join(ROLLBACK_DIR, `${TAG_1141}.down.sql`), "utf8");
    const stripped = stripSqlComments(down);

    it("adds a NOT VALID check constraint before asserting NOT NULL", () => {
      expect(stripped).toMatch(/ADD\s+CONSTRAINT\s+"chk_projects_pm_workspace_id_not_null"[\s\S]*?NOT\s+VALID/i);
    });

    it("validates that constraint before the SET NOT NULL so the scan happens without an ACCESS EXCLUSIVE hold", () => {
      const validateAt = stripped.search(/VALIDATE\s+CONSTRAINT\s+"chk_projects_pm_workspace_id_not_null"/i);
      const setNotNullAt = stripped.search(/ALTER\s+COLUMN\s+"pm_workspace_id"\s+SET\s+NOT\s+NULL/i);
      expect(validateAt).toBeGreaterThan(-1);
      expect(setNotNullAt).toBeGreaterThan(-1);
      expect(validateAt).toBeLessThan(setNotNullAt);
    });

    it("drops the scaffolding constraint once NOT NULL is back", () => {
      expect(stripped).toMatch(/DROP\s+CONSTRAINT\s+"chk_projects_pm_workspace_id_not_null"/i);
    });

    it("sets a lock timeout", () => {
      expect(down).toMatch(/SET\s+lock_timeout\s*=\s*'5s'/i);
    });
  });

  describe("1142 repairs the composite SET NULL with a column list", () => {
    const body = bodyOf(TAG_1142);
    const stripped = stripSqlComments(body);

    it("sets a lock timeout before touching the table", () => {
      expect(body).toMatch(/SET\s+lock_timeout\s*=\s*'5s'/i);
    });

    it("drops the broken constraint before re-adding it", () => {
      const dropAt = stripped.search(/DROP\s+CONSTRAINT\s+"fk_job_requisitions_headcount_org"/i);
      const addAt = stripped.search(/ADD\s+CONSTRAINT\s+"fk_job_requisitions_headcount_org"/i);
      expect(dropAt).toBeGreaterThan(-1);
      expect(addAt).toBeGreaterThan(dropAt);
    });

    it("names only the nullable headcount_id in the SET NULL column list so org_id is never nulled", () => {
      expect(stripped).toMatch(/ON\s+DELETE\s+SET\s+NULL\s*\(\s*"headcount_id"\s*\)/i);
    });

    it("every SET NULL in the forward migration carries a column list", () => {
      const all = stripped.match(/ON\s+DELETE\s+SET\s+NULL/gi) ?? [];
      const withList = stripped.match(/ON\s+DELETE\s+SET\s+NULL\s*\(/gi) ?? [];
      expect(all.length).toBeGreaterThan(0);
      expect(withList.length).toBe(all.length);
    });

    it("adds the constraint NOT VALID and validates it in a separate statement", () => {
      const notValidAt = stripped.search(/NOT\s+VALID/i);
      const validateAt = stripped.search(/VALIDATE\s+CONSTRAINT\s+"fk_job_requisitions_headcount_org"/i);
      expect(notValidAt).toBeGreaterThan(-1);
      expect(validateAt).toBeGreaterThan(notValidAt);
    });

    it("separates every statement with the breakpoint marker the applier splits on", () => {
      const statements = body
        .split("--> statement-breakpoint")
        .map((s) => stripSqlComments(s).trim())
        .filter((s) => s.length > 0);
      expect(statements.length).toBe(4);
    });

    it("has a rollback file on disk", () => {
      expect(existsSync(join(ROLLBACK_DIR, `${TAG_1142}.down.sql`))).toBe(true);
    });
  });

  describe("1142 rollback deliberately restores the broken bare SET NULL", () => {
    const down = readFileSync(join(ROLLBACK_DIR, `${TAG_1142}.down.sql`), "utf8");
    const stripped = stripSqlComments(down);

    it("re-adds the constraint with no column list, which is the pre-repair defect", () => {
      expect(stripped).toMatch(/ON\s+DELETE\s+SET\s+NULL/i);
      expect(stripped).not.toMatch(/ON\s+DELETE\s+SET\s+NULL\s*\(/i);
    });

    it("guards the drop with IF EXISTS so the rollback is re-runnable", () => {
      expect(stripped).toMatch(/DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+"fk_job_requisitions_headcount_org"/i);
    });

    it("sets a lock timeout", () => {
      expect(down).toMatch(/SET\s+lock_timeout\s*=\s*'5s'/i);
    });
  });

  describe("sealed chain coverage is reported honestly rather than assumed", () => {
    it("neither 1141 nor 1142 is in the sealed chain hash file, so the immutability gate does not pin them", () => {
      const sealed = new Set(chain.entries.map((e) => e.tag));
      expect(sealed.has(TAG_1141)).toBe(false);
      expect(sealed.has(TAG_1142)).toBe(false);
    });

    it("every sealed chain entry still has a file on disk", () => {
      const fileTags = new Set(sqlFileTags);
      expect(chain.entries.filter((e) => !fileTags.has(e.tag)).map((e) => e.tag)).toEqual([]);
    });

    it("records the current bytes of both migrations so an out-of-band edit fails this spec", () => {
      const digest = (tag: string) => createHash("sha256").update(readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`))).digest("hex");
      expect(digest(TAG_1141)).toBe("a65318a8013ed2c733be1c6af0f8529fe43b7d09d7667e71a0e6ce0aa3951042");
      expect(digest(TAG_1142)).toBe("96f76c745ff077deafac70f5e5960cefc38f2c136f709b8890a904ca07e26ba3");
    });
  });
});
