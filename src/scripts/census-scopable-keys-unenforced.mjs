/**
 * Lead generator: a permission key declared `scopable: true` whose routes never
 * apply a scope.
 *
 * The INVERSE of the usual defect. Elsewhere a capability exists and nothing
 * reaches it; here a REQUIREMENT exists and nothing satisfies it. An
 * administrator grants a rep `own` on a scopable key, the product accepts the
 * grant, stores it, shows it back on the access screen — and the query ignores
 * it. Nothing looks broken from any angle except the data.
 *
 * Written after `crm:deals:read` turned out to be exactly that: `listDeals`
 * honoured the scope and `getDeal`, ninety lines below it in the same file, did
 * not.
 *
 * ## HOW THIS SCRIPT HAS ALREADY BEEN WRONG — read before believing a number
 *
 * Twice, in the same session, in the direction that produces an alarming report.
 *
 * 1. It listed four spellings of "the scope reached the query" and reported
 *    `crm:commission-earnings:view` as NEVER APPLIED. That is compensation
 *    data, and the catalogue entry beside it says in as many words that a
 *    `?userId=` for a colleague "would otherwise be an authorised salary leak".
 *    The route enforces it perfectly, through `readRequestScope(req)` — a
 *    spelling the regex did not know. I was one step from filing a salary leak
 *    that did not exist.
 * 2. It checked only the CONTROLLER file, and most modules here resolve the
 *    scope one layer down in the service. That version said 48 of 53 keys were
 *    unenforced. Timesheets applies `applyScope` in `entries-read.service.ts`,
 *    not in `entries.controller.ts`.
 *
 * It now searches the controller's whole DIRECTORY, which is coarse in a stated
 * way: a module where one route scopes and another does not reads as clean. It
 * answers "does this module know about scoping at all". Anything it flags still
 * needs reading — `surveys:*` was verified by hand before being believed.
 *
 * DELIBERATELY NOT A `check:*` GATE. Several hits are in modules this branch
 * does not own, some scopable keys are administrative by design, and a CI
 * failure would be answered with a suppression list — which is how a census
 * stops being read.
 *
 * Usage: `node src/scripts/census-scopable-keys-unenforced.mjs`
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (f.endsWith(".ts")) out.push(f);
  }
  return out;
}

const ALL = walk("src");
const CATALOG = ALL.filter((f) => f.includes("/rbac/permissions/"));
const CODE = ALL.filter((f) => !f.includes("/rbac/permissions/") && !f.includes(".spec."));

const scopable = new Set();
for (const f of CATALOG) {
  const s = readFileSync(f, "utf8");
  for (const m of s.matchAll(/name:\s*"([^"]+)"[^}]*?scopable:\s*true/gs)) scopable.add(m[1]);
}

// Which keys does a route actually gate on, and does that file resolve a scope?
const gated = new Map();
for (const f of CODE) {
  const s = readFileSync(f, "utf8");
  for (const m of s.matchAll(/@RequirePermission\(\s*"([^"]+)"/g)) {
    if (!scopable.has(m[1])) continue;
    if (!gated.has(m[1])) gated.set(m[1], new Set());
    gated.get(m[1]).add(f);
  }
}

/*
 * Every way this repository spells "the caller's scope reached the query".
 *
 * My first version listed four and reported `crm:commission-earnings:view` as
 * NEVER APPLIED — a salary leak, if it had been true. That controller reads
 * `readRequestScope(req)`, which the regex did not name. Fifth time today a
 * census has produced an alarming answer I was ready to act on, and the fifth
 * time verifying one entry by hand was what saved it.
 */
const SCOPE_SIGNAL = /applyScope|DataScope|scopeFor\(|resolve\w*Scope|readRequestScope|rbacScope|viewAll/;

/**
 * Does the controller's own DIRECTORY apply a scope anywhere?
 *
 * Checking the controller file alone was wrong, and wrong in the direction that
 * produces an alarming report: most modules here resolve the scope one layer
 * down, in the service. That version said 48 of 53 keys were unenforced, which
 * would have been the largest finding of the day and was an artifact of where I
 * looked. Timesheets applies `applyScope` in `entries-read.service.ts`, not in
 * `entries.controller.ts`.
 *
 * Directory-level is COARSE and its limit must be stated: a module where one
 * route scopes and another does not now reads as clean. It answers "does this
 * module know about scoping at all", which is the honest question a text scan
 * can answer. Anything it flags still needs reading.
 */
const dirCache = new Map();
function scopedNear(file) {
  const dir = file.slice(0, file.lastIndexOf("/"));
  if (dirCache.has(dir)) return dirCache.get(dir);
  let found = false;
  for (const f of walk(dir)) {
    if (f.includes(".spec.")) continue;
    if (SCOPE_SIGNAL.test(readFileSync(f, "utf8"))) { found = true; break; }
  }
  dirCache.set(dir, found);
  return found;
}

const rows = [];
for (const key of [...scopable].sort()) {
  const files = [...(gated.get(key) ?? [])];
  if (files.length === 0) { rows.push({ key, state: "NO ROUTE", files: [] }); continue; }
  const withScope = files.filter((f) => scopedNear(f));
  rows.push({
    key,
    state: withScope.length === 0 ? "NEVER APPLIED" : withScope.length === files.length ? "ok" : "PARTIAL",
    files: files.filter((f) => !scopedNear(f)),
  });
}

console.log(`# scopable keys: ${scopable.size}\n`);
for (const r of rows.filter((r) => r.state !== "ok")) {
  console.log(`${r.state.padEnd(13)} ${r.key}`);
  for (const f of r.files) console.log(`              ${f.replace("src/modules/", "")}`);
}
console.log(`\n# ok: ${rows.filter((r) => r.state === "ok").length}`);
