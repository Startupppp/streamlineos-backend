import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * `notifications.actor_user_id` is a FOREIGN KEY to `users(id)`, so a sentinel
 * string put there is refused by the database.
 *
 * `tax-compliance.service.ts` passed `actorUserId: "system"` on every tax-due
 * notification. There is no user row with that id, so wherever
 * `notifications_actor_user_id_users_id_fk` exists — the schema declares it and
 * migration 0000 creates it — the insert is refused. It never surfaced because
 * the emit ends in `.catch(logSideEffectFailure(...))`: the whole feature failed
 * into a log line.
 *
 * WHY A SOURCE SCAN AND NOT A DATABASE TEST. The shared Neon branch currently
 * has NO such foreign key (0421 is one of ~140 migrations unapplied there), so
 * an integration test against it passes over the defect and reports the sentinel
 * as fine. The environment where this bites is a cold build, which is the one a
 * test run is least likely to be pointed at. The source is the same on both.
 *
 * The column is nullable precisely so a background sweep can say "no actor".
 * `forEachOrg` work has no user behind it, and `null` is both true and what
 * `NotificationDispatchService` expects — its self-notification filter is then
 * skipped rather than comparing every recipient against a value that can never
 * match one.
 */

const SRC = join(__dirname, "..", "..");
const SKIP = new Set(["node_modules", "dist", ".next", "__tests__"]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith(".ts") && !entry.includes(".spec.")) out.push(full);
  }
  return out;
}

/** Comments blanked, not removed, so a reported line number still points true. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

/** `actorUserId:` given a bare string literal — the shape that cannot be a user id. */
const LITERAL_ACTOR = /\bactorUserId\s*:\s*(["'])([^"']*)\1/g;

function literalActors(): string[] {
  const found: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const raw = readFileSync(file, "utf8");
    if (!raw.includes("actorUserId")) continue;
    const src = codeOnly(raw);
    for (const m of src.matchAll(LITERAL_ACTOR)) {
      const line = src.slice(0, m.index).split("\n").length;
      found.push(`${file.replace(SRC + "/", "")}:${line} actorUserId: "${m[2]}"`);
    }
  }
  return found;
}

describe("a notification actor is a real user or nobody", () => {
  it("reads the tree it claims to, so the case below is not vacuous", () => {
    // A walker that finds nothing reports no violations and looks identical to
    // a clean codebase.
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(500);
    expect(files.some((f) => f.endsWith("notification-dispatch.service.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("tax-compliance.service.ts"))).toBe(true);
  });

  it("can see a literal actor when one is there", () => {
    // Proves the matcher works, without needing a violation to exist.
    const sample = codeOnly(`await emit({ orgId, actorUserId: "system", targetUserIds: [] });`);
    expect([...sample.matchAll(LITERAL_ACTOR)].map((m) => m[2])).toEqual(["system"]);
    // ...and does not match the honest forms.
    for (const ok of [`actorUserId: null`, `actorUserId: userId`, `actorUserId: u.userId ?? null`]) {
      expect([...codeOnly(ok).matchAll(LITERAL_ACTOR)]).toHaveLength(0);
    }
  });

  it("passes no string literal where a user id belongs", () => {
    // A background sweep has no actor. Say `null`, which the column allows,
    // rather than a sentinel the foreign key will refuse.
    expect(literalActors()).toEqual([]);
  });
});
