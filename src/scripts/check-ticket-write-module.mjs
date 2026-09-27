#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = resolve(__dirname, "../..");
const BUILD_ROOT = join(BACKEND_ROOT, "src/modules/build");
const RATCHET_PATH = join(__dirname, "ticket-write-module-ratchet.json");

const SELF_TEST = process.argv.includes("--self-test");

const WRITE_PATTERN = /\.update\(\s*tickets\s*\)/;

const CHANGE_MODULE = new Set([
  "src/modules/build/core/tickets/apply-ticket-change.ts",
  "src/modules/build/core/tickets/projects-tickets-rank-utils.ts",
  "src/modules/build/core/tickets/build-ticket-bulk-mutation.ts",
]);

const MIN_SCANNED = 60;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (
      entry.endsWith(".ts") &&
      !entry.endsWith(".spec.ts") &&
      !entry.endsWith(".e2e-spec.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

function norm(abs) {
  return relative(BACKEND_ROOT, abs).replace(/\\/g, "/");
}

export function writesToTickets(text) {
  return WRITE_PATTERN.test(text);
}

export function checkRatchet(writing, ratchet) {
  const newBypasses = writing.filter((f) => !ratchet.includes(f));
  const stale = ratchet.filter((r) => !writing.includes(r));
  return { newBypasses, stale };
}

export function scanFiles(files) {
  const writing = [];
  for (const f of files) {
    const rel = norm(f);
    if (CHANGE_MODULE.has(rel)) continue;
    const text = readFileSync(f, "utf8");
    if (writesToTickets(text)) writing.push(rel);
  }
  return writing.sort();
}

function runSelfTest() {
  const failures = [];
  const assert = (label, cond) => {
    if (!cond) failures.push(label);
  };

  assert(
    "a .update(tickets) call is detected as a write to the tickets table",
    writesToTickets("await tx.update(tickets).set({ status: 'DONE' }).where(eq(tickets.id, id));"),
  );

  assert(
    "a file with no .update(tickets) call is not flagged",
    !writesToTickets("await tx.select().from(tickets).where(eq(tickets.id, id));"),
  );

  assert(
    "a .update() call on a different table is not flagged",
    !writesToTickets("await tx.update(projects).set({ name: 'x' }).where(eq(projects.id, id));"),
  );

  const { newBypasses: nb1, stale: st1 } = checkRatchet(
    ["src/modules/build/core/some-new-service.ts"],
    [],
  );
  assert(
    "a file writing to tickets that is not in the ratchet is reported as a new bypass",
    nb1.length === 1 && nb1[0] === "src/modules/build/core/some-new-service.ts",
  );
  assert(
    "a new bypass produces no stale entries",
    st1.length === 0,
  );

  const { newBypasses: nb2, stale: st2 } = checkRatchet(
    [],
    ["src/modules/build/core/old-service.ts"],
  );
  assert(
    "a ratchet entry that no longer writes tickets is reported as stale",
    st2.length === 1 && st2[0] === "src/modules/build/core/old-service.ts",
  );
  assert(
    "a stale ratchet entry produces no new bypasses",
    nb2.length === 0,
  );

  const { newBypasses: nb3, stale: st3 } = checkRatchet(
    ["src/modules/build/core/grandfathered.ts"],
    ["src/modules/build/core/grandfathered.ts"],
  );
  assert(
    "a file in the ratchet that still writes tickets produces no findings",
    nb3.length === 0 && st3.length === 0,
  );

  assert(
    "MIN_SCANNED is large enough to catch a broken file walker",
    MIN_SCANNED >= 60,
  );

  if (failures.length > 0) {
    for (const f of failures) console.error(`  FAIL: ${f}`);
    console.error(`check-ticket-write-module self-test: ${failures.length} failed`);
    process.exit(1);
  }
  console.log(`check-ticket-write-module self-tests: ${failures.length === 0 ? 6 : 0} passed`);
  process.exit(0);
}

if (SELF_TEST) runSelfTest();

const files = walk(BUILD_ROOT);

if (files.length < MIN_SCANNED) {
  console.error(
    `INCONCLUSIVE — scanned only ${files.length} source files under src/modules/build (floor ${MIN_SCANNED}). The file walker is broken.`,
  );
  process.exit(2);
}

const ratchet = JSON.parse(readFileSync(RATCHET_PATH, "utf8"));
const writing = scanFiles(files);

console.log(
  `Scanned ${files.length} source files under src/modules/build — ${writing.length} write to tickets outside the change module.`,
);
console.log(
  `\nChange module (always allowed): apply-ticket-change.ts, projects-tickets-rank-utils.ts, build-ticket-bulk-mutation.ts`,
);
console.log(
  `Scans for: the pattern .update(tickets) in non-spec TypeScript source files.`,
);
console.log(
  `Cannot see: indirect writes through service method chains; raw SQL UPDATE statements (use .update(tickets) pattern — raw SQL UPDATE is checked separately); dynamically resolved table handles; writes inside generated code; stored procedures.`,
);

const { newBypasses, stale } = checkRatchet(writing, ratchet);

if (stale.length > 0) {
  console.error(
    `\nFAIL — ${stale.length} stale ratchet entry (entries). These files no longer write to tickets; remove them from ticket-write-module-ratchet.json:`,
  );
  for (const f of stale) console.error(`  ${f}`);
}

if (newBypasses.length > 0) {
  console.error(
    `\nFAIL — ${newBypasses.length} new bypass(es) write to tickets outside the change module.`,
  );
  console.error(
    `Route the write through applyTicketChange, rankTicket, or bulkMutateTickets, or add the file to ticket-write-module-ratchet.json with a justification comment in the ticket.`,
  );
  for (const f of newBypasses) console.error(`  ${f}`);
}

if (stale.length > 0 || newBypasses.length > 0) {
  process.exit(1);
}

console.log(
  `\nOK — ${ratchet.length} grandfathered bypass(es) in ratchet, 0 new bypasses, 0 stale entries.`,
);
