/**
 * Lead generator: SQLSTATE checks that cannot fire.
 *
 * Drizzle raises a `DrizzleQueryError` and hangs the driver's error off `cause`,
 * so `err.code === "23505"` reads the WRAPPER's code — which is undefined — and
 * matches nothing. Every handler written that way believes it is catching a
 * unique violation and is catching none, so a duplicate key reaches the client
 * as a 500 instead of the 409 the author intended.
 *
 * PER FUNCTION, NOT PER FILE, and that distinction is the whole point. A
 * file-level "does it mention `cause`" test under-counts: `quality-inspections`
 * mentions `cause` elsewhere and still has a check that reads only the top
 * frame. Measuring by file said 58; measuring by function says more.
 *
 * DELIBERATELY NOT A `check:*` GATE. It cannot see a caller that has already
 * unwrapped, and several hits are in modules this branch does not own. Its
 * output is a lead list.
 *
 * The fix is always the same: import from `common/db/postgres-error` —
 * `isUniqueViolation` (23505), `isForeignKeyViolation` (23503),
 * `isCheckViolation` (23514), `isExclusionViolation` (23P01) — rather than
 * writing a fifth walk. There were four copies of that walk in this repository
 * when this was written, two of them one letter apart in the same directory.
 *
 * Usage: `node src/scripts/census-dead-sqlstate-checks.mjs [dir]`
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.argv[2] ?? "src";
const SQLSTATES = /"(23505|23503|23514|23P01)"/;

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|mts)$/.test(e) && !e.includes(".spec.")) out.push(full);
  }
  return out;
}

/**
 * Split a source into brace-balanced top-level-ish blocks starting at every
 * `function` or method head, so a check can be attributed to the body it sits
 * in rather than to the file.
 */
function blocks(source) {
  const lines = source.split("\n");
  const heads = [];
  for (let i = 0; i < lines.length; i++)
    if (/^\s*(export\s+)?(async\s+)?function\s|^\s{2}(private |public |protected )?(async )?[A-Za-z][A-Za-z0-9_]*\(/.test(lines[i]))
      heads.push(i);
  return heads.map((start, n) => ({
    line: start + 1,
    name: (/([A-Za-z][A-Za-z0-9_]*)\s*\(/.exec(lines[start]) ?? [, "?"])[1],
    body: lines.slice(start, heads[n + 1] ?? lines.length).join("\n"),
  }));
}

const dead = [];
let examined = 0;
let usesHelper = 0;
for (const file of walk(ROOT)) {
  const src = readFileSync(file, "utf8");
  if (!SQLSTATES.test(src)) continue;
  if (/from "[^"]*common\/db\/postgres-error"/.test(src)) usesHelper++;
  for (const b of blocks(src)) {
    if (!SQLSTATES.test(b.body)) continue;
    examined++;
    /*
     * Everything BELOW the head line. Testing the whole body made this census
     * miss exactly what it exists to find: a locally-declared
     * `function isUniqueViolation(...)` contains its own name, so the
     * "already uses the shared helper" test matched the declaration and skipped
     * it. Two live dead checks in `quality/` were reported as clean, and the
     * first version of this script printed a module list with `inventory`
     * absent — which I published. Read the body, not the signature.
     */
    const inner = b.body.split("\n").slice(1).join("\n");
    if (/\bcause\b/.test(inner)) continue;
    if (/isUniqueViolation|isForeignKeyViolation|isCheckViolation|isExclusionViolation|postgresErrorCode|getPostgresErrorCode|getPostgresErrorDetails/.test(inner))
      continue;
    dead.push({ file, ...b });
  }
}

console.log(`# checks that read only the top frame: ${dead.length} of ${examined} examined`);
console.log(`# files already importing the shared helper: ${usesHelper}`);
console.log("# A LEAD LIST, not a bug count — a caller may have unwrapped already.\n");
const byModule = new Map();
for (const d of dead) {
  const key = d.file.split("/").slice(0, 3).join("/");
  byModule.set(key, (byModule.get(key) ?? 0) + 1);
}
for (const [mod, n] of [...byModule.entries()].sort((a, b) => b[1] - a[1]))
  console.log(`${String(n).padStart(3)}  ${mod}`);
console.log("");
for (const d of dead.slice(0, 40)) console.log(`  ${d.file}:${d.line}  ${d.name}()`);
