#!/usr/bin/env node
/**
 * Gate: every relation key a read path ships is a name the frontend has heard of.
 *
 * THE DEFECT THIS EXISTS TO STOP. Drizzle's `with: { … }` puts a joined row on
 * the wire under the RELATION's name, which is a schema detail. When that name
 * is not the name the client declared, both repositories typecheck clean and the
 * screen renders wrong — never an error, always a plausible blank. Seven
 * instances shipped in this release. Three of them (`membership` on support
 * watchers, `user` pointing at `organization_members` on build watchers,
 * `orgDepartment` on HR internal openings) are exactly this: a name the backend
 * ships that no frontend file has ever mentioned.
 *
 * WHY A NAME TEST AND NOT A TYPE COMPARISON. Two measurements say a real
 * comparator is not available here. `apiClient.get<T>` is a cast, so the
 * frontend type never meets the wire; and `db.query.x.findMany({ with: { y },
 * columns: { id: true } })` infers `{ id: number }[]` on this schema — the
 * `with:` contributes NOTHING to the inferred type, so the backend compiler
 * cannot see these keys either. Neither side has a type to compare. What is
 * left that is both cheap and sound is the crudest possible question: does the
 * name the backend is about to ship appear ANYWHERE in the frontend? A "no" is
 * not proof of a bug, but it was right 5 times out of 17 on the sweep that
 * found these — and the 12 misses were all triaged in one sitting.
 *
 * WHAT THIS GATE CANNOT SEE. Stated here because a gate whose blind spots are
 * only in a report gets quoted as if it had none. It also prints them on every
 * run.
 *
 *   1. SAME NAME, DIFFERENT SUB-SHAPE. This asks about the top-level key only.
 *      `sender` appears all over the frontend, so a `sender` whose inner fields
 *      disagree is invisible. That was finding #1 of the seven — `senderId`
 *      emitted by no read path — and rule 2 below is what surfaces its cousin.
 *   2. `db.select({ … })` PROJECTIONS. Only the relational query builder has a
 *      `with:`. A hand-built projection that names a column differently from the
 *      frontend is not enumerated at all.
 *   3. VALUE-LEVEL DIVERGENCE. A field present on both sides carrying a
 *      MEMBERSHIP id where the client compares a USER id passes every rule here.
 *      That was the huddle `startedBy` bug, and no static name test can reach it.
 *   4. FALSE "KNOWN" VERDICTS. `user`, `message`, `ticket`, `project`,
 *      `attachments` all appear in the frontend for unrelated reasons, so they
 *      clear on the name alone. 96 of 111 keys clear this way.
 *
 * The runtime instrument for 1, 3 and 4 is a response contract at the fetch seam
 * (`frontend/scripts/check-response-contracts.mjs`). This gate is the static,
 * one-second half; it does not replace that one.
 *
 * TWO RULES.
 *   A. relation reach — a `with:` key that appears nowhere in the frontend.
 *   B. empty projection — `columns: {}` selects NOTHING and silently emits `{}`.
 *      Cheaper than rule A and it is what surfaced findings #1 and #2.
 *
 * Usage:
 *   node src/scripts/check-relation-key-reach.mjs
 *   node src/scripts/check-relation-key-reach.mjs --list
 *   node src/scripts/check-relation-key-reach.mjs --json
 *   node src/scripts/check-relation-key-reach.mjs --self-test
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FRONTEND_ROOT,
  frontendAvailable,
  frontendUnreachableReason,
  reportUnreachable,
} from "./check-repo-paths.mjs";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_SRC = join(SCRIPT_DIR, "..");

/** A broken scan must read as broken, never as green. */
const MIN_BACKEND_FILES = 2000;
const MIN_FRONTEND_FILES = 2500;
const MIN_RELATION_KEYS = 80;

/**
 * Every `with:` key that no frontend file mentions, with the verdict that was
 * reached on it and the files it may appear in.
 *
 * This is NOT an allowlist of safe names. Each entry is a name somebody looked
 * at once and decided about; the `files` list is what pins that decision to the
 * place it was made, so the SAME key surfacing in a NEW service fails. An entry
 * whose files have all gone fails as stale, so the list cannot rot into
 * scenery.
 */
const RELATION_BASELINE = new Map([
  [
    "assigneeMembership",
    {
      files: [
        "modules/support/core/support-sla.service.ts",
        "modules/support/core/support-ticket-messages.service.ts",
        "modules/support/core/support-tickets.service.ts",
      ],
      reason:
        "the client declares assignee/assigneeId and reads neither — no assignee picker or avatar exists in the ticket UI. Latent: the first component to trust the type breaks.",
    },
  ],
  [
    "creatorMembership",
    {
      files: [
        "modules/support/core/support-macros.service.ts",
        "modules/support/core/support-ticket-messages.service.ts",
        "modules/support/core/support-tickets.service.ts",
      ],
      reason: "same as assigneeMembership — declared as creator/createdBy, read by nothing.",
    },
  ],
  [
    "csm",
    {
      files: ["modules/crm/core/crm-ce-dashboard.service.ts"],
      reason: "CRM is out of the 10/10 release scope. Untriaged, deliberately.",
    },
  ],
  [
    "currentLocation",
    {
      files: ["modules/inventory/traceability/inv-traceability.service.ts"],
      reason: "Inventory is out of the 10/10 release scope. Untriaged, deliberately.",
    },
  ],
  [
    "poster",
    {
      files: ["modules/inventory/stock/inv-stock-adjustments.service.ts"],
      reason: "Inventory is out of the 10/10 release scope. Untriaged, deliberately.",
    },
  ],
  [
    "headMember",
    {
      files: ["modules/branches/branches-read.service.ts"],
      reason: "flattened to branchManager before it reaches the wire — the relation name never ships.",
    },
  ],
  [
    "panelMembers",
    {
      files: ["modules/hr/interviews/hr-interviews.service.ts"],
      reason: "mapped to panelInterviewerIds before it reaches the wire.",
    },
  ],
  [
    "workItem",
    {
      files: ["modules/build/core/projects-ticket-relations.service.ts"],
      reason: "collapsed into relatedTicket before it reaches the wire.",
    },
  ],
  [
    "relatedWorkItem",
    {
      files: ["modules/build/core/projects-ticket-relations.service.ts"],
      reason: "collapsed into relatedTicket before it reaches the wire.",
    },
  ],
  [
    "senderMembership",
    {
      files: [
        "modules/chat/chat-message-timeline.service.ts",
        "modules/chat/chat-pins.service.ts",
        "modules/chat/chat-presence.service.ts",
        "modules/chat/chat-saved.service.ts",
        "modules/chat/chat-search.service.ts",
      ],
      reason:
        "lifted to senderId/sender by flattenMessageSender before the wire (commit 15f36ff9). chat-presence.service.ts is the one exception: GET /chat/presence/search still emits it nested and has NO frontend caller — a deletion candidate, not a fix candidate.",
    },
  ],
  [
    "pinnedByMembership",
    {
      files: ["modules/chat/chat-pins.service.ts"],
      reason: "lifted to pinnedBy before the wire, as a by-product of the sender flattening.",
    },
  ],
  [
    "startedByMembership",
    {
      files: ["modules/chat/chat-huddles.service.ts"],
      reason: "lifted to a flat startedBy user id by loadHuddleWire (commit 755b45e3).",
    },
  ],
  [
    "organizer",
    {
      files: ["modules/hr/directory/team-events.service.ts"],
      reason:
        "GET /hr/team-events has NO frontend call site. A dead read path — one hook away from becoming the next instance.",
    },
  ],
  [
    "userMember",
    {
      files: ["modules/build/execution/timesheets.service.ts"],
      reason:
        "GET /build/time-entries/team has NO frontend call site. A dead read path — one hook away from becoming the next instance.",
    },
  ],
  [
    "redemptions",
    {
      files: ["modules/billing/core/billing-coupons.ts"],
      reason:
        "GET /billing/coupons has NO frontend call site. A dead read path — one hook away from becoming the next instance.",
    },
  ],
]);

/**
 * `columns: {}` selects nothing and emits `{}` — the relation is joined, paid
 * for, and arrives empty. It is how the huddle roster lost `userId`.
 */
const EMPTY_COLUMNS_BASELINE = new Map([
  [
    "modules/chat/chat-reply-reminders.service.ts",
    "internal email composition — the row is used for its existence only and never reaches the wire.",
  ],
]);

const BACKEND_TEST_RE = /(\.spec\.ts|e2e-spec\.ts)$/;

/**
 * A key that appears ONLY in a frontend test does not clear, and neither does one
 * that appears only in a COMMENT or a string literal — the corpus is masked with
 * `maskNonCode` before it is searched.
 *
 * Found twice by this gate biting its own author. The wire-shape BITE tests for
 * `check:response-contracts` name `senderMembership` and `startedByMembership` in
 * their "the payload that actually shipped" fixtures; then the doc comment on
 * `hooks/api/chat-schema.ts` named `senderMembership` while explaining the
 * defect. Both cleared the key as "known to the frontend". A fixture and a
 * comment that exist precisely to record that the name is WRONG are the last
 * things that should clear it.
 *
 * The cost is a name the frontend reads only through a string literal
 * (`row["orgDepartment"]`); it would flag. That is a triageable false positive,
 * and the trade is right: a false positive is read once, a false clear is never
 * read at all.
 */
const FRONTEND_TEST_RE = /\.(test|spec)\.tsx?$/;

function sourceFiles(dir, re, testRe, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
    if (entry === "__tests__" || entry === "__mocks__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, re, testRe, out);
      continue;
    }
    if (!re.test(entry)) continue;
    if (testRe.test(entry)) continue;
    out.push(full);
  }
  return out;
}

/**
 * Blank every string literal and comment, preserving length and newlines so
 * every offset and line number still refers to the real file.
 *
 * Without this the `with:` search matches inside `const sql = "with: { … }"`
 * and inside a doc comment that quotes one — this file's own header quotes
 * `with: { … }` four times, so a gate that skipped this step would flag its own
 * prose. Caught by self-test (b), not by review.
 *
 * A template literal is blanked whole, interpolations included. A `with:` block
 * built inside `${…}` would be missed; no query in this repository does that,
 * and the alternative is a full parse for a one-second gate.
 */
export function maskNonCode(text) {
  const out = text.split("");
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i += 1)
      if (out[i] !== "\n") out[i] = " ";
  };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      let j = i;
      while (j < text.length && text[j] !== "\n") j += 1;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const j = end === -1 ? text.length : end + 2;
      blank(i, j);
      i = j - 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === c) break;
        j += 1;
      }
      blank(i, Math.min(j + 1, text.length));
      i = j;
      continue;
    }
  }
  return out.join("");
}

/**
 * Brace-match from the `{` at `start` to its partner. A regex cannot do this: a
 * `with:` block nests `columns:`, `where:` and further `with:` blocks, and the
 * first `}` is almost never the end.
 */
export function matchBlock(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i += 1;
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === quote) break;
        i += 1;
      }
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The `key:` names at depth 0 of a block body — the relation names themselves. */
export function topLevelKeys(body) {
  const keys = [];
  let depth = 0;
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === "/" && body[i + 1] === "/") {
      while (i < body.length && body[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && body[i + 1] === "*") {
      const end = body.indexOf("*/", i + 2);
      i = end === -1 ? body.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i += 1;
      while (i < body.length) {
        if (body[i] === "\\") {
          i += 2;
          continue;
        }
        if (body[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (c === "{" || c === "[" || c === "(") {
      depth += 1;
      i += 1;
      continue;
    }
    if (c === "}" || c === "]" || c === ")") {
      depth -= 1;
      i += 1;
      continue;
    }
    if (depth === 0 && /[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < body.length && /[\w$]/.test(body[j])) j += 1;
      const word = body.slice(i, j);
      let k = j;
      while (k < body.length && /\s/.test(body[k])) k += 1;
      if (body[k] === ":") keys.push(word);
      i = j;
      continue;
    }
    i += 1;
  }
  return keys;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text[i] === "\n") line += 1;
  return line;
}

/**
 * Every relation key a file's `with:` blocks ship, and every `columns: {}` it
 * holds.
 *
 * A `with:` NESTED inside another one is its own block and its keys are
 * collected too — a second-level relation name reaches the wire exactly as a
 * first-level one does, so `with: { membership: { with: { user } } }` must
 * contribute both `membership` and `user`.
 */
export function scanBackendSource(label, text) {
  const code = maskNonCode(text);
  const relationKeys = [];
  const withRe = /\bwith\s*:\s*\{/g;
  let match;
  while ((match = withRe.exec(code)) !== null) {
    const open = code.indexOf("{", match.index);
    const close = matchBlock(code, open);
    if (close === -1) continue;
    const line = lineOf(code, match.index);
    for (const key of topLevelKeys(code.slice(open + 1, close)))
      relationKeys.push({ key, file: label, line });
  }
  const emptyColumns = [];
  const emptyRe = /\bcolumns\s*:\s*\{\s*\}/g;
  while ((match = emptyRe.exec(code)) !== null)
    emptyColumns.push({ file: label, line: lineOf(code, match.index) });
  return { relationKeys, emptyColumns };
}

function posix(p) {
  return p.split(sep).join("/");
}

export function evaluate(
  relationKeys,
  emptyColumns,
  corpus,
  counts,
  relationBaseline = RELATION_BASELINE,
  emptyBaseline = EMPTY_COLUMNS_BASELINE,
) {
  const byKey = new Map();
  for (const site of relationKeys) {
    if (!byKey.has(site.key)) byKey.set(site.key, []);
    byKey.get(site.key).push(site);
  }

  const unreached = [];
  for (const [key, sites] of byKey) {
    if (new RegExp(`\\b${key}\\b`).test(corpus)) continue;
    unreached.push({ key, sites });
  }

  const newKeys = [];
  const newSites = [];
  for (const { key, sites } of unreached) {
    const entry = relationBaseline.get(key);
    if (entry === undefined) {
      newKeys.push(`${key} — shipped by ${sites.map((s) => `${s.file}:${s.line}`).join(", ")}`);
      continue;
    }
    for (const site of sites)
      if (!entry.files.includes(site.file))
        newSites.push(`${key} in a file the verdict did not cover: ${site.file}:${site.line}`);
  }

  const reachedKeys = new Set(byKey.keys());
  const unreachedKeys = new Set(unreached.map((u) => u.key));
  const staleKeys = [];
  for (const [key, entry] of relationBaseline) {
    if (!unreachedKeys.has(key)) {
      staleKeys.push(
        reachedKeys.has(key)
          ? `${key} is now mentioned in the frontend — delete the line`
          : `${key} is no longer shipped by any with: block — delete the line`,
      );
      continue;
    }
    const live = new Set(byKey.get(key).map((s) => s.file));
    for (const file of entry.files)
      if (!live.has(file)) staleKeys.push(`${key} no longer appears in ${file} — delete that path`);
  }

  const emptyFiles = new Set(emptyColumns.map((e) => e.file));
  const newEmpty = emptyColumns
    .filter((e) => !emptyBaseline.has(e.file))
    .map((e) => `${e.file}:${e.line}`);
  const staleEmpty = [...emptyBaseline.keys()].filter((f) => !emptyFiles.has(f));

  return {
    distinctKeys: byKey.size,
    keySites: relationKeys.length,
    unreached,
    emptyColumns,
    failures: [
      counts.backendFiles < MIN_BACKEND_FILES
        ? `scan floor: ${counts.backendFiles} backend source files, below the ${MIN_BACKEND_FILES} this tree is known to hold — the scanner is broken, not the tree`
        : null,
      counts.frontendFiles < MIN_FRONTEND_FILES
        ? `scan floor: ${counts.frontendFiles} frontend source files, below the ${MIN_FRONTEND_FILES} this tree is known to hold — the corpus is broken, and a broken corpus flags EVERYTHING`
        : null,
      byKey.size < MIN_RELATION_KEYS
        ? `scan floor: ${byKey.size} distinct relation keys, below the ${MIN_RELATION_KEYS} this tree is known to hold — the extractor is broken`
        : null,
      newKeys.length > 0
        ? `relation key shipped under a name the frontend has never heard of:\n    ${newKeys.join("\n    ")}\n  Either the client reads it under a different name (the defect), or nothing reads it (a dead read path). Decide which, then add it to RELATION_BASELINE with the reason.`
        : null,
      newSites.length > 0
        ? `a triaged relation key in an untriaged place:\n    ${newSites.join("\n    ")}`
        : null,
      staleKeys.length > 0
        ? `stale RELATION_BASELINE entry (the verdict no longer describes the tree):\n    ${staleKeys.join("\n    ")}`
        : null,
      newEmpty.length > 0
        ? `columns: {} selects NOTHING and emits {} — the relation is joined, paid for and arrives empty:\n    ${newEmpty.join("\n    ")}`
        : null,
      staleEmpty.length > 0
        ? `stale EMPTY_COLUMNS_BASELINE entry (resolve it or delete the line): ${staleEmpty.join(", ")}`
        : null,
    ].filter((f) => f !== null),
  };
}

const BLIND_SPOTS = [
  "same key name, different sub-shape — only the top-level name is tested",
  "db.select({ ... }) projections — only the relational query builder has a with:",
  "value-level divergence — a membership id where the client compares a user id",
  "a name that appears in the frontend for an unrelated reason clears on the name alone",
];

function fixture(name, lines) {
  return scanBackendSource(name, lines.join("\n"));
}

function selfTest() {
  const checks = [];
  const assert = (label, actual, expected) => {
    checks.push({
      label,
      ok: JSON.stringify(actual) === JSON.stringify(expected),
      actual,
      expected,
    });
  };
  const counts = { backendFiles: MIN_BACKEND_FILES, frontendFiles: MIN_FRONTEND_FILES };
  const padKeys = (keys) => keys.concat(Array.from({ length: MIN_RELATION_KEYS }, (_, i) => ({ key: `pad${i}`, file: "pad.ts", line: 1 })));
  const padCorpus = Array.from({ length: MIN_RELATION_KEYS }, (_, i) => `pad${i}`).join(" ");

  // (a) a nested block does not truncate the outer match, `columns:` keys are
  //     not relations, and a nested relation name is collected in its own right.
  assert(
    "relation names are collected at every with: depth, and columns: keys are not",
    fixture("a.ts", [
      "const rows = await db.query.tickets.findMany({",
      "  with: {",
      "    assigneeMembership: { columns: { userId: true }, with: { user: { columns: { id: true } } } },",
      "    watchers: true,",
      "  },",
      "});",
    ]).relationKeys.map((r) => r.key),
    ["assigneeMembership", "watchers", "user"],
  );

  // (b) a `with:` inside a string or a comment is not a with: block.
  assert(
    "strings and comments do not produce relation keys",
    fixture("b.ts", [
      'const sql = "with: { ghost: true }";',
      "// with: { alsoGhost: true }",
      "/* with: { stillGhost: true } */",
      "const real = { with: { member: true } };",
    ]).relationKeys.map((r) => r.key),
    ["member"],
  );

  // (c) a second, sibling with: block in the same file is its own block.
  assert(
    "sibling blocks are both read, with their own lines",
    fixture("c.ts", [
      "await db.query.a.findMany({ with: { one: true } });",
      "await db.query.b.findMany({ with: { two: true } });",
    ]).relationKeys.map((r) => `${r.key}:${r.line}`),
    ["one:1", "two:2"],
  );

  // (d) columns: {} is found, and a populated columns: is not.
  assert(
    "an empty projection is found and a populated one is not",
    fixture("d.ts", [
      "await db.query.a.findFirst({ columns: {} });",
      "await db.query.b.findFirst({ columns: { id: true } });",
      "await db.query.c.findFirst({ columns:   {   } });",
    ]).emptyColumns.map((e) => e.line),
    [1, 3],
  );

  // (e) BITE — a key the frontend never mentions fails, and names the file.
  const bite = evaluate(
    padKeys([{ key: "orgDepartment", file: "modules/hr/jobs.service.ts", line: 12 }]),
    [],
    `${padCorpus} department departmentId`,
    counts,
    new Map(),
    new Map(),
  );
  assert("an unreached relation key fails", bite.failures.length, 1);
  assert(
    "and it names the key and the site",
    bite.failures[0].includes("orgDepartment") &&
      bite.failures[0].includes("modules/hr/jobs.service.ts:12"),
    true,
  );

  // (f) the same key, once triaged, passes — and only in the file it was triaged in.
  const triaged = new Map([
    ["orgDepartment", { files: ["modules/hr/jobs.service.ts"], reason: "fixed by an explicit leftJoin" }],
  ]);
  assert(
    "a triaged key in its triaged file passes",
    evaluate(
      padKeys([{ key: "orgDepartment", file: "modules/hr/jobs.service.ts", line: 12 }]),
      [],
      padCorpus,
      counts,
      triaged,
      new Map(),
    ).failures.length,
    0,
  );
  assert(
    "the same key in a NEW file fails",
    evaluate(
      padKeys([
        { key: "orgDepartment", file: "modules/hr/jobs.service.ts", line: 12 },
        { key: "orgDepartment", file: "modules/hr/openings.service.ts", line: 40 },
      ]),
      [],
      padCorpus,
      counts,
      triaged,
      new Map(),
    ).failures.some((f) => f.startsWith("a triaged relation key in an untriaged place")),
    true,
  );

  // (g) a key the frontend DOES mention passes on the name alone. This is
  //     blind spot 4, asserted rather than left implicit.
  assert(
    "a key the frontend mentions clears on the name alone — blind spot, not a pass",
    evaluate(
      padKeys([{ key: "sender", file: "modules/chat/timeline.service.ts", line: 9 }]),
      [],
      `${padCorpus} const sender = message.sender;`,
      counts,
      new Map(),
      new Map(),
    ).failures.length,
    0,
  );

  // (g2) BITE — the two false clears this gate found in its own author's work.
  //      A name mentioned only in a comment, or only in a test fixture asserting
  //      that the name is WRONG, must not clear the key.
  assert(
    "a name that appears only in a comment does not clear",
    evaluate(
      padKeys([{ key: "senderMembership", file: "modules/chat/timeline.service.ts", line: 9 }]),
      [],
      maskNonCode(`${padCorpus}\n// the backend ships senderMembership here, which is the defect`),
      counts,
      new Map(),
      new Map(),
    ).failures.length,
    1,
  );
  assert(
    "the same name in real code does clear",
    evaluate(
      padKeys([{ key: "senderMembership", file: "modules/chat/timeline.service.ts", line: 9 }]),
      [],
      maskNonCode(`${padCorpus}\nconst id = row.senderMembership.userId;`),
      counts,
      new Map(),
      new Map(),
    ).failures.length,
    0,
  );

  // (h) a baseline entry whose key is gone fails as stale.
  assert(
    "a stale baseline key fails",
    evaluate(padKeys([]), [], padCorpus, counts, triaged, new Map()).failures.some((f) =>
      f.startsWith("stale RELATION_BASELINE entry"),
    ),
    true,
  );

  // (i) an un-baselined columns: {} fails; a baselined one does not.
  assert(
    "a new empty projection fails",
    evaluate(padKeys([]), [{ file: "modules/x/y.service.ts", line: 5 }], padCorpus, counts, new Map(), new Map())
      .failures.some((f) => f.startsWith("columns: {} selects NOTHING")),
    true,
  );
  assert(
    "a baselined empty projection passes",
    evaluate(
      padKeys([]),
      [{ file: "modules/x/y.service.ts", line: 5 }],
      padCorpus,
      counts,
      new Map(),
      new Map([["modules/x/y.service.ts", "internal only"]]),
    ).failures.length,
    0,
  );

  // (j) a broken scan reads as broken, not as green — in all three directions.
  assert(
    "an empty backend scan fails the floor rather than passing",
    evaluate([], [], padCorpus, { backendFiles: 0, frontendFiles: MIN_FRONTEND_FILES }, new Map(), new Map())
      .failures.some((f) => f.startsWith("scan floor")),
    true,
  );
  assert(
    "an empty frontend corpus fails the floor rather than flagging everything",
    evaluate(padKeys([]), [], "", { backendFiles: MIN_BACKEND_FILES, frontendFiles: 0 }, new Map(), new Map())
      .failures.some((f) => f.includes("a broken corpus flags EVERYTHING")),
    true,
  );
  assert(
    "an extractor that finds nothing fails the key floor",
    evaluate([], [], padCorpus, counts, new Map(), new Map()).failures.some((f) =>
      f.includes("distinct relation keys"),
    ),
    true,
  );

  for (const c of checks)
    console.log(
      `${c.ok ? "ok  " : "FAIL"}  ${c.label}${c.ok ? "" : `\n        expected ${JSON.stringify(c.expected)}\n        actual   ${JSON.stringify(c.actual)}`}`,
    );
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} self-test assertions passed.`);
  return failed === 0 ? 0 : 1;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) return selfTest();

  if (!frontendAvailable)
    reportUnreachable(
      "check-relation-key-reach",
      "the frontend corpus, and with it BOTH rules",
      frontendUnreachableReason(),
    );

  const backendFiles = sourceFiles(BACKEND_SRC, /\.ts$/, BACKEND_TEST_RE);
  const relationKeys = [];
  const emptyColumns = [];
  for (const file of backendFiles) {
    const label = posix(relative(BACKEND_SRC, file));
    const scan = scanBackendSource(label, readFileSync(file, "utf8"));
    relationKeys.push(...scan.relationKeys);
    emptyColumns.push(...scan.emptyColumns);
  }

  const frontendFiles = sourceFiles(FRONTEND_ROOT, /\.tsx?$/, FRONTEND_TEST_RE);
  const corpus = frontendFiles
    .map((f) => maskNonCode(readFileSync(f, "utf8")))
    .join("\n");

  const result = evaluate(relationKeys, emptyColumns, corpus, {
    backendFiles: backendFiles.length,
    frontendFiles: frontendFiles.length,
  });

  if (args.includes("--json")) {
    process.stdout.write(
      JSON.stringify({
        backendFiles: backendFiles.length,
        frontendFiles: frontendFiles.length,
        distinctKeys: result.distinctKeys,
        keySites: result.keySites,
        unreached: result.unreached,
        emptyColumns: result.emptyColumns,
        failures: result.failures,
      }),
    );
    return result.failures.length === 0 ? 0 : 1;
  }

  console.log("Relation keys the backend ships, against the names the frontend knows\n");
  console.log(`  Backend files scanned:     ${backendFiles.length}`);
  console.log(`  Frontend corpus:           ${frontendFiles.length} files`);
  console.log(`  Distinct with: keys:       ${result.distinctKeys} over ${result.keySites} sites`);
  console.log(`  Unknown to the frontend:   ${result.unreached.length} (${RELATION_BASELINE.size} triaged)`);
  console.log(`  columns: {} sites:         ${result.emptyColumns.length} (${EMPTY_COLUMNS_BASELINE.size} triaged)\n`);

  if (args.includes("--list")) {
    for (const { key, sites } of [...result.unreached].sort((a, b) => a.key.localeCompare(b.key))) {
      const entry = RELATION_BASELINE.get(key);
      console.log(`  ${key}  ${sites.map((s) => `${s.file}:${s.line}`).join(", ")}`);
      console.log(`      ${entry === undefined ? "UNTRIAGED" : entry.reason}`);
    }
    console.log("");
  }

  console.log("This gate CANNOT see:");
  for (const spot of BLIND_SPOTS) console.log(`  - ${spot}`);
  console.log(
    "  The runtime half is frontend `pnpm check:response-contracts`; this is the static half.\n",
  );

  if (result.failures.length === 0) {
    console.log(
      `PASS: every one of the ${result.distinctKeys} relation keys is either a name the frontend knows or a triaged entry.`,
    );
    return 0;
  }
  for (const failure of result.failures) console.error(`FAIL: ${failure}`);
  return 1;
}

process.exitCode = main();
