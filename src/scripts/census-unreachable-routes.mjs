#!/usr/bin/env node
/**
 * A backend route no frontend ever calls.
 *
 * TS-11 built `GET /timesheets/periods/overdue`, guarded it with two tests, and
 * recorded the ticket done. Nothing called it — no hook, no route, no nav entry
 * — so the escalation data it computed reached no user at all. The tests passed
 * because the route works; working and reachable are different questions.
 *
 * Matches on the static prefix of a route, because the frontend builds
 * parameterised paths with template literals and `/x/${id}/y` shares no literal
 * substring with `x/:id/y`.
 *
 * WHAT A RESULT FROM THIS DOES AND DOES NOT MEAN. It answers "no frontend file
 * names this prefix", which is evidence, not a verdict. Every finding needs the
 * code read before it is called a defect — three times running, the route name
 * said one thing and the docblock above it said another:
 *
 *   - `pharmacy/h1-register` reads like a missing statutory register. Its
 *     docblock says it is a stub that "makes no compliance claim", behind a
 *     jurisdiction flag defaulting off. A UI would surface a stub as a register.
 *   - `suggestions/generate-po` reads like a planner who cannot act. The product
 *     raises POs through `/replenishment/po-batches` instead; it is superseded.
 *   - seven `/ai/*` CRM endpoints read like missing features. The frontend calls
 *     an `/ai/crm/*` generation of the same ideas; also superseded.
 *
 * The one it found that was real is TS-09: `POST /timesheets/entries/from-attendance`,
 * built with a permission key, idempotency and an own-time-only guarantee, and
 * no button anywhere.
 *
 * THREE OF ITS OWN BUGS, each of which produced a confident wrong answer:
 *
 *   1. The self-test probed for a route containing "timesheets", so pointed at
 *      inventory it failed closed and refused to print. Failing closed was right;
 *      being module-specific was not. It now asks only that SOME scanned route is
 *      one the frontend really calls.
 *   2. Machine-driven routes were classified by PATH. Nothing in
 *      `/cron/inventory-channel-snapshot`'s original spelling said "scheduler" —
 *      the signal is the guard, `assertCronSecret`. A scheduler route is not
 *      missing a UI, and counting it buries the real findings.
 *   3. One file may declare MORE THAN ONE `@Controller`, and taking the first
 *      base for every route in the file reported the nightly re-slot sweep as
 *      `/inventory/slotting/inventory-reslot` when it is `/cron/inventory-reslot`
 *      — a wrong path, and a wrong verdict with it.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const [backendRoot, frontendRoot, ...only] = process.argv.slice(2);

function walk(d, out = []) {
  let entries;
  try { entries = readdirSync(d); } catch { return out; }
  for (const e of entries) {
    if (e === "node_modules" || e === ".next" || e === ".git") continue;
    const p = join(d, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

const beFiles = walk(backendRoot).filter(
  (f) => f.endsWith(".controller.ts") && only.some((m) => f.includes(m)),
);
const feFiles = walk(frontendRoot).filter((f) => !f.includes("__tests__") && !/\.test\.tsx?$/.test(f));
const feText = feFiles.map((f) => readFileSync(f, "utf8")).join("\n");

const routes = [];
for (const file of beFiles) {
  const text = readFileSync(file, "utf8");
  /*
   * One file can declare MORE THAN ONE controller, and taking the first
   * `@Controller` base for every route in the file reports the wrong path.
   * `slotting.controller.ts` holds both the slotting controller and a
   * `@Controller("cron")` for the nightly re-slot sweep, so the sweep was
   * reported as `/inventory/slotting/inventory-reslot` when it is
   * `/cron/inventory-reslot` — a wrong path, and a wrong verdict with it.
   * Each route now takes the nearest preceding `@Controller`.
   */
  const bases = [...text.matchAll(/@Controller\(\s*["'`]([^"'`]*)["'`]/g)].map((b) => ({
    at: b.index ?? 0,
    base: b[1].replace(/^\/|\/$/g, ""),
  }));
  if (bases.length === 0) continue;
  const baseAt = (idx) => {
    let chosen = bases[0].base;
    for (const b of bases) if (b.at <= idx) chosen = b.base;
    return chosen;
  };
  const re = /@(Get|Post|Patch|Put|Delete)\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)/g;
  let m;
  while ((m = re.exec(text))) {
    const sub = (m[2] ?? "").replace(/^\/|\/$/g, "");
    const base = baseAt(m.index);
    const full = [base, sub].filter(Boolean).join("/");
    // static prefix = everything before the first :param
    const stat = full.split("/").reduce((acc, seg) => (acc.done || seg.startsWith(":") ? { ...acc, done: true } : { parts: [...acc.parts, seg], done: false }), { parts: [], done: false }).parts.join("/");
    routes.push({ file, method: m[1], full, stat });
  }
}

/*
 * Machine-driven routes are SUPPOSED to have no frontend caller: a cron surface
 * is driven by the deployment's scheduler behind `assertCronSecret`, and an
 * inbound webhook is called by the third party. Counting them as unreachable
 * would bury the real findings in noise that is working as designed, so they are
 * classified rather than silently dropped.
 */
/*
 * Classify by the GUARD, not the path.
 *
 * The path heuristic missed `/inventory/channels/inventory-channel-snapshot`,
 * which is a scheduler route: `@Public()` because the caller is a scheduler with
 * no session, gated by `assertCronSecret`, and exposed on BOTH verbs because
 * platform schedulers differ on which they issue. Nothing in its path says so.
 * A route whose controller answers to a cron secret is not missing a UI.
 */
const cronSecretFiles = new Set(
  beFiles.filter((f) => /assertCronSecret|CRON_SECRET/.test(readFileSync(f, "utf8"))),
);
const machineDriven = (r) =>
  cronSecretFiles.has(r.file) ||
  /^cron\//.test(r.full) ||
  /(^|\/)(inbound|webhooks?)(\/|$)/.test(r.full);

const all = routes.filter((r) => r.stat && !feText.includes(r.stat));
const machine = all.filter(machineDriven);
const unreachable = all.filter((r) => !machineDriven(r));

// self-test: a route that certainly IS called must not be reported
/*
 * Generic: SOME route in the scanned set must be one the frontend really calls.
 * This was hardcoded to "timesheets" and so failed closed the moment it was
 * pointed at inventory — failing closed was right, being module-specific was not.
 */
const probe = routes.find((r) => r.stat && feText.includes(r.stat));
process.stderr.write(`self-test: found ${routes.length} routes; a known-called one resolved = ${Boolean(probe)}\n`);
if (!routes.length || !probe) {
  process.stderr.write("SELF-TEST FAILED — the matcher is not resolving real routes; numbers below mean nothing\n");
  process.exit(2);
}

console.log(`routes scanned: ${routes.length}`);
console.log(`\nmachine-driven (cron / inbound webhook), correctly uncalled: ${machine.length}`);
for (const r of machine) console.log(`    ${r.method} /${r.full}`);
console.log(`\nNO FRONTEND REFERENCE, AND NOT MACHINE-DRIVEN: ${unreachable.length}`);
const byFile = new Map();
for (const r of unreachable) {
  if (!byFile.has(r.file)) byFile.set(r.file, []);
  byFile.get(r.file).push(`${r.method} /${r.full}`);
}
for (const [f, list] of byFile) {
  /* `split("/src/")[1]` is undefined when the root was passed as a relative path. */
  const label = f.includes("/src/") ? f.slice(f.lastIndexOf("/src/") + 5) : f;
  console.log(`\n  ${label}`);
  for (const l of list) console.log(`    ${l}`);
}
