import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { QUEUE_SUBJECTS, QUEUE_SLOS } from "./index";

const BACKEND_ROOT = join(__dirname, "..", "..", "..");
const SCRIPTS_ROOT = join(BACKEND_ROOT, "src", "scripts");

/**
 * Two ways a DEAD-letter objective passes without measuring anything, both of which
 * were live for `notification_outbox`:
 *
 *   1. The registry declares the wrong table. `notification-outbox-relay` said
 *      `drains: "outbox_events"`, so its objective inherited the `dead-outbox`
 *      alert — a script that queries a table the relay never touches. The objective
 *      could not fail however many notification intents dead-lettered.
 *   2. No script reads the table at all. `grep -rln notification_outbox src/scripts`
 *      matched only check-retention-coverage.mjs: nothing watched the queue.
 *
 * `check:alert-system` cannot see either. It runs the self-test of every script in
 * its own list, and a self-test proves a predicate, not that the predicate is
 * pointed at the right table or that a table has a watcher at all. These tests are
 * where that is enforced.
 */

const OUTBOX_TABLES = ["outbox_events", "notification_outbox"] as const;

function alertScripts(): Map<string, string> {
  const sources = new Map<string, string>();
  for (const name of readdirSync(SCRIPTS_ROOT)) {
    if (!name.startsWith("alert-") || !name.endsWith(".mjs")) continue;
    sources.set(name, readFileSync(join(SCRIPTS_ROOT, name), "utf8"));
  }
  return sources;
}

function deadLetterWatchers(): Map<string, string[]> {
  const byTable = new Map<string, string[]>();
  for (const [name, source] of alertScripts()) {
    for (const table of OUTBOX_TABLES) {
      const readsTable = new RegExp(`FROM\\s+${table}\\b`).test(source);
      const readsDead = /'DEAD'/.test(source);
      if (!readsTable || !readsDead) continue;
      byTable.set(table, [...(byTable.get(table) ?? []), name]);
    }
  }
  return byTable;
}

describe("outbox DEAD-letter watch", () => {
  it("finds alert scripts to measure at all", () => {
    expect(alertScripts().size).toBeGreaterThanOrEqual(10);
  });

  it("declares no table its own relay source contradicts", () => {
    const contradictions: string[] = [];
    for (const subject of QUEUE_SUBJECTS) {
      if (subject.channel !== "outbox") continue;
      const source = readFileSync(join(BACKEND_ROOT, subject.sourceFile), "utf8");
      const named = OUTBOX_TABLES.filter((table) => source.includes(table));
      if (named.length !== 1) continue;
      if (named[0] !== subject.drains)
        contradictions.push(
          `${subject.id} declares ${subject.drains} but ${subject.sourceFile} only names ${named[0]}`,
        );
    }
    expect(contradictions).toEqual([]);
  });

  it("gives every drained outbox table a DEAD-row watcher of its own", () => {
    const watchers = deadLetterWatchers();
    const drained = new Set(
      QUEUE_SUBJECTS.filter((s) => s.channel === "outbox").map((s) => s.drains),
    );
    expect(drained.size).toBeGreaterThanOrEqual(2);
    const unwatched = [...drained].filter((table) => (watchers.get(table) ?? []).length === 0);
    expect(unwatched).toEqual([]);
  });

  it("points each DEAD-letter objective at an alert that reads its own table", () => {
    const watchers = deadLetterWatchers();
    const misrouted: string[] = [];
    for (const slo of QUEUE_SLOS) {
      if (slo.indicator.kind !== "dead-letter") continue;
      const subject = QUEUE_SUBJECTS.find((s) => s.sourceFile === slo.subject);
      if (subject === undefined || subject.channel !== "outbox") continue;
      const scripts = watchers.get(subject.drains) ?? [];
      const expected = `alert-${slo.alertId}.mjs`;
      if (!scripts.includes(expected))
        misrouted.push(
          `${slo.id} fires ${expected}, which does not read ${subject.drains} (readers: ${scripts.join(", ") || "none"})`,
        );
    }
    expect(misrouted).toEqual([]);
  });

  it("keeps every alert script the system checks on disk", () => {
    const listed = readFileSync(join(SCRIPTS_ROOT, "check-alert-system.mjs"), "utf8");
    const names = [...listed.matchAll(/"((?:alert|check)-[a-z-]+\.mjs)"/g)].map((m) => m[1]);
    expect(names).toContain("alert-dead-notification-outbox.mjs");
    const present = new Set(readdirSync(SCRIPTS_ROOT));
    expect(names.filter((n) => n !== undefined && !present.has(n))).toEqual([]);
  });
});
