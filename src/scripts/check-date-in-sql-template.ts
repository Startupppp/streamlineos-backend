/**
 * A JS `Date` interpolated into a drizzle ``sql`…`` template is a runtime crash, not a type error.
 *
 * Drizzle's COLUMN-AWARE paths serialise a Date correctly — `.set({ lockedAt: new Date() })`,
 * `eq(col, date)`, `lt(col, date)` all work, because drizzle knows the column's type and maps it.
 * The raw template does not: it forwards the Date straight to postgres-js as a bind parameter,
 * where a string is expected, and the driver throws
 *
 *     TypeError [ERR_INVALID_ARG_TYPE]: The "string" argument must be of type string or an
 *     instance of Buffer or ArrayBuffer. Received an instance of Date
 *
 * Verified 2026-09-05 against a live Neon branch through the real drizzle + postgres-js stack:
 * `db.execute(sql`… created_at < ${cutoff}`)` throws, `${cutoff.toISOString()}::timestamptz`
 * returns a row. The distinction matters because one half of a statement can work while the
 * other fails, and because postgres-js's OWN tagged template serialises Dates fine — reproducing
 * this on the driver's template rather than drizzle's is what previously produced a false all-clear.
 *
 * WHY A GATE. The failure is invisible in every static check and in most tests. `forEachOrg` logs
 * a per-org failure and continues, so the sweep still reports success and the cron endpoint still
 * answers 200; drizzle's own message is only `Failed query: <sql>` with the real reason hidden on
 * `error.cause`. That combination let the notification delivery claim fail for every organisation
 * on every tick with nothing to show for it, and it recurred in the retention sweeps.
 *
 * The check is type-directed rather than textual: it asks the checker for the type of every
 * interpolation inside a `sql` tag, so it sees a Date arriving through a variable, a parameter,
 * a field or a helper's return value — none of which a grep for `new Date()` would find.
 *
 *   pnpm check:date-in-sql-template
 *   pnpm check:date-in-sql-template:self-test
 */
import * as ts from "typescript";
import { resolve } from "node:path";

export interface DateInterpolation {
  file: string;
  line: number;
  expression: string;
  type: string;
}

const SELF_TEST = process.argv.includes("--self-test");

const MIN_FILES = 1_000;
const MIN_SQL_TEMPLATES = 50;

function tagNameOf(node: ts.TaggedTemplateExpression): string {
  const tag = node.tag;
  if (ts.isIdentifier(tag)) return tag.text;
  if (ts.isPropertyAccessExpression(tag)) return tag.name.text;
  return "";
}

/**
 * Drizzle's own wrappers carry a Date in their type parameter but never reach the driver as one —
 * a nested `SQL<Date | null>` fragment or a `PgColumn` renders to SQL, so `${lastActivityAt}`
 * inside a `COALESCE` is correct. Only a value the driver would have to serialise itself counts.
 */
const DRIZZLE_WRAPPERS = /^(SQL|SQLWrapper|Aliased|Placeholder)\b|Column|\bSQL</;

/**
 * `Date` on its own, or in a union with null/undefined. A type that also admits `string` is
 * already carrying the caller's `.toISOString()` on some branch and is not the defect.
 */
export function isBareDateType(text: string): boolean {
  if (DRIZZLE_WRAPPERS.test(text)) return false;
  if (/\bstring\b/.test(text)) return false;
  return /(^|[^A-Za-z_$])Date([^A-Za-z_$]|$)/.test(text);
}

export interface ScanResult {
  hits: DateInterpolation[];
  filesScanned: number;
  templatesSeen: number;
}

export function findDateInterpolations(program: ts.Program): ScanResult {
  const checker = program.getTypeChecker();
  const found: DateInterpolation[] = [];
  let filesScanned = 0;
  let templatesSeen = 0;

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (sourceFile.fileName.includes("node_modules")) continue;
    filesScanned++;

    const visit = (node: ts.Node): void => {
      if (ts.isTaggedTemplateExpression(node) && tagNameOf(node) === "sql") templatesSeen++;
      if (ts.isTaggedTemplateExpression(node) && tagNameOf(node) === "sql") {
        const template = node.template;
        if (ts.isTemplateExpression(template))
          for (const span of template.templateSpans) {
            const typeText = checker.typeToString(checker.getTypeAtLocation(span.expression));
            if (!isBareDateType(typeText)) continue;
            const { line } = sourceFile.getLineAndCharacterOfPosition(span.expression.getStart());
            found.push({
              file: sourceFile.fileName,
              line: line + 1,
              expression: span.expression.getText(),
              type: typeText,
            });
          }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return { hits: found, filesScanned, templatesSeen };
}

function buildProgram(fileNames: string[], options: ts.CompilerOptions): ts.Program {
  return ts.createProgram(fileNames, { ...options, noEmit: true });
}

function loadRepoProgram(): ts.Program {
  const configPath = resolve(__dirname, "..", "..", "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    resolve(__dirname, "..", ".."),
  );
  return buildProgram(parsed.fileNames, parsed.options);
}

/**
 * The self-test compiles a synthetic file holding one of each shape and asserts the check finds
 * exactly the two that crash. Without the negative cases a check that returned every
 * interpolation would pass this just as well.
 */
function runSelfTest(): void {
  const fixture = [
    'declare const sql: (s: TemplateStringsArray, ...v: unknown[]) => unknown;',
    'declare const cutoff: Date;',
    'declare const maybe: Date | null;',
    'declare const iso: string;',
    'declare const n: number;',
    'export const a = sql`select 1 where t < ${cutoff}`;',
    'export const b = sql`select 1 where t < ${maybe}`;',
    'export const c = sql`select 1 where t < ${cutoff.toISOString()}`;',
    'export const d = sql`select 1 where t < ${iso}`;',
    'export const e = sql`select 1 where n = ${n}`;',
    'export const f = sql`select 1 where t < ${new Date().toISOString()}`;',
  ].join("\n");

  // TypeScript normalises every path it handles to forward slashes, so a Windows `resolve()`
  // result never matches the name the host is asked for and the fixture silently resolves to
  // nothing — which reads as "the check found no Dates" rather than as a broken self-test.
  const fileName = resolve(__dirname, "__date-in-sql-template-self-test__.ts").replace(/\\/g, "/");
  const isFixture = (name: string): boolean => name.replace(/\\/g, "/") === fileName;
  const host = ts.createCompilerHost({ strict: true });
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreate) =>
    isFixture(name)
      ? ts.createSourceFile(name, fixture, languageVersion, true)
      : originalGetSourceFile(name, languageVersion, onError, shouldCreate);
  host.fileExists = (name) => isFixture(name) || ts.sys.fileExists(name);
  host.readFile = (name) => (isFixture(name) ? fixture : ts.sys.readFile(name));

  const program = ts.createProgram([fileName], { strict: true, noEmit: true }, host);
  const found = findDateInterpolations(program).hits.map((hit) => hit.expression);

  const expected = ["cutoff", "maybe"];
  const missed = expected.filter((e) => !found.includes(e));
  const spurious = found.filter((f) => !expected.includes(f));

  if (missed.length > 0 || spurious.length > 0) {
    console.error(
      `SELF-TEST FAIL: expected exactly [${expected.join(", ")}], got [${found.join(", ")}]` +
        (missed.length > 0 ? ` — missed ${missed.join(", ")}` : "") +
        (spurious.length > 0 ? ` — spurious ${spurious.join(", ")}` : ""),
    );
    process.exitCode = 1;
    return;
  }

  // The wrapper exclusion is asserted on the predicate directly. Producing a real `SQL<Date>`
  // in the fixture would require drizzle in the synthetic program, and a hand-rolled stand-in
  // would not print the type text the checker actually emits — so it would test nothing.
  const wrapperCases: [string, boolean][] = [
    ["SQL<Date | null>", false],
    ["SQL<Date>", false],
    ["PgColumn<{ data: Date }>", false],
    ["Aliased<Date>", false],
    ["Date", true],
    ["Date | null", true],
    ["Date | undefined", true],
    ["string", false],
    ["string | Date", false],
  ];
  const wrong = wrapperCases.filter(([text, want]) => isBareDateType(text) !== want);
  if (wrong.length > 0) {
    console.error(
      `SELF-TEST FAIL: predicate disagrees on ${wrong.map(([t]) => JSON.stringify(t)).join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    "SELF-TEST PASS: a bare Date and a Date|null are both detected; .toISOString(), a string, " +
      "a number and every drizzle SQL/Column wrapper are not.",
  );
}

function main(): void {
  if (SELF_TEST) {
    runSelfTest();
    return;
  }

  const { hits, filesScanned, templatesSeen } = findDateInterpolations(loadRepoProgram());

  // A collector that silently stops matching reports a clean sweep, which is the one outcome
  // indistinguishable from success. Exit 2 (inconclusive) rather than 0 when the corpus
  // collapses — at the time of writing the scan sees ~3,700 files and ~1,900 templates.
  if (filesScanned < MIN_FILES || templatesSeen < MIN_SQL_TEMPLATES) {
    console.error(
      `INCONCLUSIVE: scanned ${String(filesScanned)} files and ${String(templatesSeen)} sql ` +
        `templates, below the floors of ${String(MIN_FILES)}/${String(MIN_SQL_TEMPLATES)} — ` +
        "the collector is broken, not the code.",
    );
    process.exitCode = 2;
    return;
  }

  console.log(
    `Scanned ${String(filesScanned)} files — found ${String(templatesSeen)} sql template(s).`,
  );

  if (hits.length === 0) {
    console.log("PASS: no JS Date is interpolated into a drizzle sql template.");
    return;
  }

  console.error(
    `FAIL: ${hits.length} Date interpolation(s) inside a sql template — each throws ` +
      "ERR_INVALID_ARG_TYPE at runtime. Pass `.toISOString()` with an explicit ::timestamptz cast.",
  );
  for (const hit of hits)
    console.error(`  ${hit.file}:${String(hit.line)}  \${${hit.expression}} :: ${hit.type}`);
  process.exitCode = 1;
}

main();
