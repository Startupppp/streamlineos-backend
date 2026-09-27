#!/usr/bin/env node
/**
 * check-build-swallowed-writes.mjs
 *
 * Detects bare catch blocks that swallow errors from direct database writes inside
 * the Build module's service layer.
 *
 * THE DEFECT THIS CATCHES
 * `runInTenantTransaction` (tenant-context.interceptor.ts) wraps the whole HTTP
 * handler in one PostgreSQL transaction. `this.db` is a Proxy that routes every
 * statement into that ambient transaction. PostgreSQL aborts the WHOLE transaction
 * on any failed statement, so a try/catch around `await this.db.insert(...)` that
 * does not re-throw leaves the outer transaction in an aborted state. Every later
 * statement in the same request also fails, the commit becomes a rollback, and the
 * handler still returns 200. The user sees a change, reloads, and it is gone.
 *
 * WHAT THIS SCAN DETECTS
 * In every *.service.ts file under src/modules/build:
 *   try {
 *     ... await (this.db | tx | savepoint).(insert|update|delete|execute|transaction)(...)
 *   } catch {
 *     // no throw
 *   }
 *
 * WHAT THIS SCAN CANNOT SEE
 * - Indirect DB writes through service method chains. The five sites fixed by
 *   ticket 38 wrapped calls to this.activity.logTicketActivity and
 *   this.activity.processCommentMentions — methods that internally call this.db.
 *   The outer try/catch was the defect; the fix was withSavepoint(), which makes
 *   each effect run in its own SAVEPOINT so a failure rolls back only the savepoint
 *   and leaves the ambient transaction intact. A text scan cannot see the chain
 *   this.activity -> this.db, and the fixed pattern no longer contains a bare
 *   try/catch at all.
 * - DB writes via the .catch() promise method rather than a try/catch block.
 *   projects-activity.service.ts:457 uses .catch() on a notification dispatch.
 *   That site is outside the Build write path and was excluded from this gate.
 * - Runtime-resolved database handles (e.g., this[dbKey]).
 * - Generated or indirect forms that a text scan cannot enumerate.
 *
 * RATCHET
 * SWALLOWED_BASELINE is the number of hits allowed. It starts at the count of
 * pre-existing violations outside the ticket-38 territory that were confirmed
 * after the five ticket-38 sites were fixed. It may only go down.
 *
 * Usage:
 *   node src/scripts/check-build-swallowed-writes.mjs [--self-test] [--list]
 *
 * Exit codes:
 *   0 — no new violations above the baseline
 *   1 — violations above the baseline
 *   2 — scan walked nothing (vacuity guard)
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_TEST = process.argv.includes("--self-test");
const LIST = process.argv.includes("--list");

const BACKEND_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const BUILD_ROOT = join(BACKEND_ROOT, "src/modules/build");

const MIN_SERVICE_FILES = 30;

/**
 * Pre-existing violations outside ticket-38 territory confirmed after the five
 * ticket-38 sites were fixed. These files are outside this lane's edit territory;
 * the gate ratchet holds them at this count rather than forcing an immediate fix.
 *
 * Confirmed hits (file : line):
 *   src/modules/build/core/projects-activity.service.ts : 404
 *   src/modules/build/core/build-automation-run-history.service.ts : ~83 (try wrapping db.update at ~104)
 *   src/modules/build/core/build-automation-run-history.service.ts : ~129 (try wrapping db.insert at ~130)
 *   src/modules/build/core/projects-tickets-transfer.service.ts : ~197 (try wrapping tx.insert at ~198)
 */
const SWALLOWED_BASELINE = 4;

function walk(dir, out) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.service\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

/** Balance from an opening bracket at `open`, skipping string contents. */
function balance(text, open) {
  const pairs = { "(": ")", "{": "}", "[": "]" };
  const close = pairs[text[open]];
  if (!close) return open;
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch;
      i++;
      while (i < text.length) {
        if (text[i] === "\\") { i += 2; continue; }
        if (text[i] === q) break;
        i++;
      }
    } else if (ch === text[open]) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return text.length - 1;
}

const DB_WRITE_RE = /\bawait\s+(?:this\.db|tx|savepoint)\s*\.\s*(?:insert|update|delete|execute|transaction)\s*\(/;
const RETHROW_RE = /\bthrow\b/;

export function scanFile(text) {
  const hits = [];
  const TRY_RE = /\btry\s*\{/g;
  let m;
  while ((m = TRY_RE.exec(text)) !== null) {
    const openBrace = text.indexOf("{", m.index + 3);
    if (openBrace === -1 || openBrace > m.index + 10) continue;
    const tryEnd = balance(text, openBrace);
    const tryBody = text.slice(openBrace + 1, tryEnd);

    if (!DB_WRITE_RE.test(tryBody)) continue;

    const afterTry = text.slice(tryEnd + 1);
    const catchMatch = /^\s*catch\s*(?:\([^)]*\))?\s*\{/.exec(afterTry);
    if (!catchMatch) continue;

    const catchBraceOffset = catchMatch[0].lastIndexOf("{");
    const catchBraceAbs = tryEnd + 1 + catchBraceOffset;
    const catchEnd = balance(text, catchBraceAbs);
    const catchBody = text.slice(catchBraceAbs + 1, catchEnd);

    if (RETHROW_RE.test(catchBody)) continue;

    const line = text.slice(0, m.index).split("\n").length;
    hits.push({ line });
  }
  return hits;
}

function runSelfTest() {
  let failures = 0;
  let assertions = 0;
  const assert = (label, cond) => {
    assertions++;
    if (!cond) { console.error(`  FAIL ${label}`); failures++; }
  };

  const bareWrite = `
    async recordHistory(orgId, params) {
      try {
        await this.db.insert(runHistory).values({ orgId });
      } catch (error) {
        logger.error("failed", { error });
      }
    }
  `;
  assert(
    "try { await this.db.insert } catch without throw is detected",
    scanFile(bareWrite).length === 1,
  );

  const rethrowWrite = `
    async doWork() {
      try {
        await this.db.insert(table).values({ x: 1 });
      } catch (error) {
        throw error;
      }
    }
  `;
  assert(
    "try { await this.db.insert } catch { throw } is not flagged",
    scanFile(rethrowWrite).length === 0,
  );

  const savepointPattern = `
    async logActivity(orgId, ticketId, userId, action) {
      try {
        await withSavepoint(() => this.activity.logTicketActivity(orgId, ticketId, userId, action));
      } catch (error) {
        logger.error("failed", { error });
      }
    }
  `;
  assert(
    "try { await withSavepoint(...) } catch is not flagged — no direct db call visible",
    scanFile(savepointPattern).length === 0,
  );

  const txWrite = `
    async bulkInsert(orgId, items) {
      await this.db.transaction(async (tx) => {
        try {
          await tx.insert(tickets).values(items);
        } catch (error) {
          logger.error("chunk failed", { error });
        }
      });
    }
  `;
  assert(
    "try { await tx.insert } catch without throw inside a transaction is detected",
    scanFile(txWrite).length === 1,
  );

  const indirectWrite = `
    async updateTicket(u, ticketId) {
      try {
        await this.activity.logTicketActivity(u.orgId, ticketId, u.userId, "updated");
      } catch (error) {
        logger.error("failed", { error });
      }
    }
  `;
  assert(
    "try { await this.activity.method() } catch is not flagged — indirect write is not visible",
    scanFile(indirectWrite).length === 0,
  );

  const dbUpdate = `
    async stampAutomation(orgId, automationId) {
      try {
        await this.db
          .update(projectAutomations)
          .set({ lastRunAt: new Date() })
          .where(and(eq(projectAutomations.id, automationId), eq(projectAutomations.orgId, orgId)));
        return true;
      } catch (error) {
        logger.error("failed", { error });
        return null;
      }
    }
  `;
  assert(
    "try { await this.db.update } catch without throw is detected",
    scanFile(dbUpdate).length === 1,
  );

  if (failures > 0) {
    console.error(`check-build-swallowed-writes self-test: ${failures} failed`);
    process.exit(1);
  }
  console.log(`check-build-swallowed-writes self-tests: ${assertions} passed`);
  process.exit(0);
}

if (SELF_TEST) runSelfTest();

const files = [];
walk(BUILD_ROOT, files);

if (files.length < MIN_SERVICE_FILES) {
  console.error(
    `INCONCLUSIVE — walked ${files.length} service files under modules/build (floor ${MIN_SERVICE_FILES}). The walk is broken.`,
  );
  process.exit(2);
}

const hits = [];
for (const f of files) {
  const text = readFileSync(f, "utf8");
  const fileHits = scanFile(text);
  for (const h of fileHits) {
    hits.push({ file: relative(BACKEND_ROOT, f), line: h.line });
  }
}

console.log(
  `Scanned ${files.length} service files under src/modules/build  ·  ${hits.length} swallowed-write site(s) found`,
);
console.log(
  `\nScans: try blocks whose body contains a direct call to this.db.insert/update/delete/execute/transaction or tx.insert/update/delete/execute inside a catch that does not re-throw.`,
);
console.log(
  `Cannot see: indirect DB writes through service method chains (e.g., this.activity.logTicketActivity calls this.db internally — fixed in ticket 38 by withSavepoint); .catch() promise method; runtime-resolved handles; generated or indirect forms.`,
);

if (LIST || hits.length > 0) {
  for (const h of hits) {
    console.log(`  ${h.file}:${h.line}`);
  }
}

if (hits.length > SWALLOWED_BASELINE) {
  console.error(
    `\nFAIL — ${hits.length} swallowed-write site(s), ${hits.length - SWALLOWED_BASELINE} above the ratchet of ${SWALLOWED_BASELINE}.`,
  );
  process.exit(1);
}

console.log(
  `\nOK — ${hits.length} swallowed-write site(s) (ratchet ${SWALLOWED_BASELINE}).`,
);
