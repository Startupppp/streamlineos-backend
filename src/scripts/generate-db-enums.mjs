#!/usr/bin/env node
/**
 * generate-db-enums.mjs
 *
 * Derives ONE TypeScript module from every `pgEnum(...)` declaration in
 * `src/db/schema/**` and writes it to `src/db/enums.generated.ts`.
 *
 * WHY THIS EXISTS. The schema declares hundreds of `pgEnum`s. Against them the
 * repository hand-writes a `z.enum([...])` copy per DTO, and types many
 * enum-shaped columns as a plain `z.string()`. `check:contract-parity` compares
 * the frontend contract against the backend contract, so it is structurally
 * blind to both mistakes: `string` is a superset of every enum, and two
 * hand-written copies that are wrong in the same way agree with each other.
 * A member added to a pgEnum and missed by a copy is a runtime
 * `ApiContractError` on the first row that carries it.
 *
 * The generated module is the single source both repositories read, so a copy
 * cannot silently fall behind the column it describes.
 *
 * VENDORING. `frontend/contracts/db-enums.generated.ts` is a byte-identical
 * copy, hash-gated by `frontend: check:db-enums-vendor`, exactly the way
 * `openapi.json` and `contracts/permission-catalog.json` already are.
 *
 * The file is a pure function of the schema sources — no timestamp, no git SHA,
 * enum names sorted — so "byte-for-byte identical" is a meaningful claim and a
 * regeneration with no schema change is a no-op diff.
 *
 * Flags:
 *   (none)        Write src/db/enums.generated.ts.
 *   --check       Exit 1 if the file on disk differs from a fresh generation.
 *   --self-test   Run the parser's internal assertions against synthetic input.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BACKEND_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA_ROOT = join(BACKEND_ROOT, "src", "db", "schema");
export const OUTPUT_PATH = join(BACKEND_ROOT, "src", "db", "enums.generated.ts");

/**
 * Removes `//` and block comments without touching anything inside a string or
 * template literal. A naive regex strip mangles `pgEnum("http://...")`-shaped
 * members, and leaving comments in place lets a commented-out member
 * (`// "grni",`) be read as live — `gl_system_tag` carries a block comment
 * between two of its members today.
 */
export function stripComments(source) {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i++;
      while (i < n) {
        if (source[i] === "\\") {
          out += source[i] + (source[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += source[i];
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

const PG_ENUM_RE = /pgEnum\(\s*(["'])([A-Za-z0-9_]+)\1\s*,\s*\[([^\]]*)\]/g;
const MEMBER_RE = /(["'])((?:\\.|(?!\1)[^\\])*)\1/g;

/**
 * Returns [{ name, members }] for every pgEnum declared in one source file, in
 * declaration order. Only array-literal declarations are matched: a pgEnum
 * built from a spread or a variable has no literal member list to read, and
 * inventing one would be worse than reporting none.
 */
export function parsePgEnums(source) {
  const clean = stripComments(source);
  const found = [];
  for (const match of clean.matchAll(PG_ENUM_RE)) {
    const name = match[2];
    const members = [...match[3].matchAll(MEMBER_RE)].map((m) => m[2]);
    if (members.length === 0) continue;
    found.push({ name, members });
  }
  return found;
}

function listSchemaFiles(dir, files = []) {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      listSchemaFiles(full, files);
      continue;
    }
    if (extname(entry) !== ".ts") continue;
    if (entry.endsWith(".d.ts") || entry.endsWith(".spec.ts")) continue;
    files.push(full);
  }
  return files;
}

/**
 * Merges the per-file parses into one name -> members map.
 *
 * A pg enum name declared twice with the SAME members is deduplicated: the
 * schema re-exports a handful of enums through barrels and both sites are the
 * same declaration. Declared twice with DIFFERENT members it throws, because
 * there is then no single answer to "what can this column hold" and silently
 * picking one would bake a guess into both repositories.
 */
export function collectEnums(sources) {
  const byName = new Map();
  for (const { file, source } of sources) {
    for (const { name, members } of parsePgEnums(source)) {
      const existing = byName.get(name);
      if (existing === undefined) {
        byName.set(name, { members, file });
        continue;
      }
      const same =
        existing.members.length === members.length &&
        existing.members.every((m, idx) => m === members[idx]);
      if (!same) {
        throw new Error(
          `pgEnum "${name}" is declared twice with different members:\n` +
            `  ${existing.file}: [${existing.members.join(", ")}]\n` +
            `  ${file}: [${members.join(", ")}]`,
        );
      }
    }
  }
  return byName;
}

const HEADER = `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Every \`pgEnum\` declared under \`backend/src/db/schema/**\`, as the literal
 * member list Postgres will accept for that column.
 *
 * Regenerate:  pnpm -C backend generate:db-enums
 * Re-vendor:   pnpm -C frontend generate:db-enums
 *
 * Gates:       backend  check:db-enums          (file matches the schema)
 *              frontend check:db-enums-vendor   (both copies are byte-identical)
 *
 * Read a member list from here instead of hand-writing \`z.enum([...])\`, and
 * never type an enum-shaped column as \`z.string()\`:
 *
 *     import { DB_ENUMS } from "src/db/enums.generated";
 *     category: z.enum(DB_ENUMS.notification_category),
 */
`;

const FOOTER = `
export type DbEnumName = keyof typeof DB_ENUMS;
export type DbEnumMember<N extends DbEnumName> = (typeof DB_ENUMS)[N][number];
`;

export function renderModule(byName) {
  const names = [...byName.keys()].sort();
  const body = names
    .map((name) => {
      const members = byName.get(name).members.map((m) => JSON.stringify(m)).join(", ");
      return `  ${name}: [${members}],`;
    })
    .join("\n");
  return `${HEADER}\nexport const DB_ENUMS = {\n${body}\n} as const;\n${FOOTER}`;
}

/**
 * Compared with line endings normalised. Git may hand back CRLF on a Windows
 * checkout while a fresh render always produces LF, and reporting that as
 * schema drift would make the gate permanently red on one platform and say
 * nothing true about the enums.
 */
export function normalise(text) {
  return text.replace(/\r\n/g, "\n");
}

export function generate() {
  const files = listSchemaFiles(SCHEMA_ROOT);
  const sources = files.map((file) => ({
    file: relative(BACKEND_ROOT, file).split("\\").join("/"),
    source: readFileSync(file, "utf8"),
  }));
  const byName = collectEnums(sources);
  return { contents: renderModule(byName), count: byName.size, fileCount: files.length };
}

function runSelfTest() {
  const cases = [];
  const assert = (description, passes) => cases.push({ description, passes });

  assert(
    "a single-line pgEnum yields its name and every member",
    (() => {
      const [e] = parsePgEnums('export const a = pgEnum("party_role", ["customer", "vendor", "both"]);');
      return e.name === "party_role" && e.members.join(",") === "customer,vendor,both";
    })(),
  );

  assert(
    "a multi-line pgEnum yields every member across the lines",
    (() => {
      const [e] = parsePgEnums(
        'export const s = pgEnum("timesheet_period_status", [\n  "OPEN",\n  "DRAFT",\n  "LOCKED",\n]);',
      );
      return e.members.join(",") === "OPEN,DRAFT,LOCKED";
    })(),
  );

  assert(
    "a block comment between two members does not swallow the member after it",
    (() => {
      const [e] = parsePgEnums(
        'pgEnum("gl_system_tag", [\n  "cash",\n  /**\n   * Goods received not invoiced.\n   */\n  "grni",\n  "sales",\n]);',
      );
      return e.members.join(",") === "cash,grni,sales";
    })(),
  );

  assert(
    "a commented-out member is NOT read as live, so a removal cannot be undone by a comment",
    (() => {
      const [e] = parsePgEnums('pgEnum("x", [\n  "a",\n  // "removed",\n  "b",\n]);');
      return e.members.join(",") === "a,b";
    })(),
  );

  assert(
    "a // sequence inside a string member is not treated as a comment",
    stripComments('const u = "https://example.com"; // trailing').trim() ===
      'const u = "https://example.com";',
  );

  assert(
    "two pgEnums in one source are both returned",
    parsePgEnums('pgEnum("a", ["x"]);\npgEnum("b", ["y", "z"]);').length === 2,
  );

  assert(
    "the same enum declared twice with identical members is deduplicated, not duplicated",
    collectEnums([
      { file: "a.ts", source: 'pgEnum("dup", ["x", "y"]);' },
      { file: "b.ts", source: 'pgEnum("dup", ["x", "y"]);' },
    ]).size === 1,
  );

  assert(
    "the same enum declared twice with different members throws instead of silently picking one",
    (() => {
      try {
        collectEnums([
          { file: "a.ts", source: 'pgEnum("dup", ["x", "y"]);' },
          { file: "b.ts", source: 'pgEnum("dup", ["x"]);' },
        ]);
        return false;
      } catch (error) {
        return error instanceof Error && error.message.includes("declared twice");
      }
    })(),
  );

  assert(
    "the rendered module sorts enum names, so regeneration is a no-op diff",
    (() => {
      const rendered = renderModule(
        collectEnums([{ file: "a.ts", source: 'pgEnum("zeta", ["z"]);\npgEnum("alpha", ["a"]);' }]),
      );
      return rendered.indexOf("alpha:") < rendered.indexOf("zeta:");
    })(),
  );

  assert(
    "the rendered module closes DB_ENUMS with `as const`, without which z.enum loses the literals",
    renderModule(collectEnums([{ file: "a.ts", source: 'pgEnum("a", ["x"]);' }])).includes("} as const;"),
  );

  assert(
    "a CRLF copy of an LF render is not reported as drift",
    normalise("a\r\nb\r\n") === normalise("a\nb\n"),
  );

  assert(
    "a pgEnum with no literal member list is skipped rather than emitted empty",
    parsePgEnums('pgEnum("built", SOME_MEMBERS);').length === 0,
  );

  assert(
    "the real schema yields at least 400 enums, so an empty sweep cannot pass",
    generate().count >= 400,
  );

  assert(
    "the real schema yields notification_category including ACCOUNTING",
    generate().contents.includes('"SUPPORT", "ACCOUNTING"'),
  );

  const failures = cases.filter((c) => !c.passes);
  for (const c of cases) {
    if (c.passes) console.log(`OK   self-test passed: ${c.description}`);
  }
  for (const f of failures) console.error(`FAIL self-test FAILED: ${f.description}`);
  if (failures.length > 0) process.exit(1);
  console.log(`\nAll ${cases.length} self-test cases passed — generate-db-enums is live.`);
  process.exit(0);
}

function main() {
  if (process.argv.includes("--self-test")) runSelfTest();

  const { contents, count, fileCount } = generate();

  if (process.argv.includes("--check")) {
    if (!existsSync(OUTPUT_PATH)) {
      console.error("check:db-enums FAILED — src/db/enums.generated.ts does not exist.");
      console.error("   Generate it:  pnpm -C backend generate:db-enums");
      process.exit(1);
    }
    const onDisk = normalise(readFileSync(OUTPUT_PATH, "utf8"));
    if (onDisk === normalise(contents)) {
      console.log(`check:db-enums OK — src/db/enums.generated.ts matches the schema (${count} enums).`);
      process.exit(0);
    }
    console.error("check:db-enums FAILED — src/db/enums.generated.ts is STALE.");
    console.error("   A pgEnum changed and the generated module was not regenerated, so every");
    console.error("   DTO reading it still describes the old column.");
    console.error("   Fix:  pnpm -C backend generate:db-enums && pnpm -C frontend generate:db-enums");
    process.exit(1);
  }

  writeFileSync(OUTPUT_PATH, contents, "utf8");
  console.log(`Wrote src/db/enums.generated.ts — ${count} enums from ${fileCount} schema files.`);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
