import fs from "node:fs";
import path from "node:path";

/**
 * Phase 3, ticket 07 — a party is not created without asking what the plan allows.
 *
 * The ticket was written about autonomous writers, and the audit behind it found
 * something broader: of the four places that insert a `business_parties` row,
 * *three* consulted no limit at all. One of them was the inbound workflow, where
 * a stream of email could create records without bound and nobody had asked for
 * any of them. The other two were the ordinary human and import paths, which had
 * simply never been given the assertion that thirty-seven other write paths in
 * this codebase already carry.
 *
 * A quota that is not enforced is a marketing claim rather than a quota, and the
 * failure is silent: a tenant on a hundred records quietly holds nine thousand,
 * and the first anyone knows is the invoice conversation.
 *
 * So this reads the source. Every `insert(businessParties)` must either consult
 * a plan limit in its own file, or be named below with a reason.
 *
 * The two shapes are both allowed on purpose, because the actor decides which is
 * correct:
 *
 *   - `assertWithinLimit` **throws**, which is right when a person is waiting for
 *     an answer and can be told to upgrade;
 *   - `evaluateAutonomousWrite` **returns a verdict**, which is right when
 *     throwing would unwind an ingest carrying a customer's message — refusing to
 *     record that an email arrived, because a plan limit was reached, loses the
 *     message.
 */

const MODULES = path.join(__dirname, "..");

/** Either enforcement shape, plus the non-throwing lookup the second one needs. */
const CONSULTS_A_LIMIT = /assertWithinLimit|evaluateAutonomousWrite|limitFor\(/;

/**
 * Files that insert a party and legitimately do not check.
 *
 * Listed one by one rather than matched by pattern, so adding one is a
 * deliberate act somebody has to write a sentence about.
 */
const EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    "party/party-legacy-writer.ts",
    // `insertBareParty` is the seam, not a call site. It is what `contacts`,
    // `leads`, `clients` and `crm_organizations` all write *through*, and each of
    // those callers asserts its own limit before reaching here. Asserting again
    // inside would charge one record against the plan twice and would refuse an
    // import that the caller had already cleared.
    "the shared seam; every caller asserts its own limit before reaching it",
  ],
]);

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      walk(full, found);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith("spec.ts")) {
      found.push(full);
    }
  }
  return found;
}

describe("every path that creates a party asks what the plan allows", () => {
  it("finds no insert that skips the question", () => {
    const unguarded: string[] = [];

    for (const file of walk(MODULES)) {
      const source = fs.readFileSync(file, "utf8");
      if (!source.includes("insert(businessParties)")) continue;

      const relative = path.relative(MODULES, file).split(path.sep).join("/");
      if (EXEMPT.has(relative)) continue;
      if (CONSULTS_A_LIMIT.test(source)) continue;

      unguarded.push(relative);
    }

    // Named rather than counted, so a failure says which file to look at.
    expect(unguarded).toEqual([]);
  });

  /**
   * The other direction, so the exemption list cannot rot.
   *
   * An entry that no longer inserts a party is an entry that stopped meaning
   * anything and would quietly excuse the next thing added to that file.
   */
  it("keeps no exemption for a file that no longer creates a party", () => {
    const stale = [...EXEMPT.keys()].filter((relative) => {
      const full = path.join(MODULES, relative);
      if (!fs.existsSync(full)) return true;
      return !fs.readFileSync(full, "utf8").includes("insert(businessParties)");
    });

    expect(stale).toEqual([]);
  });
});
