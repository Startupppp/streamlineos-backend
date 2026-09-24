import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The words a board integration is not allowed to say while `ADAPTERS` is
 * empty.
 *
 * This is a text sweep, which is a blunt instrument — but the defect it exists
 * for was exactly a string: `publish` returned the literal `"PUBLISHED"` and
 * `syncPortal` returned `"SYNC_INITIATED"` plus "New applications will appear
 * in the ATS pipeline shortly", from code paths that made no network call. A
 * type cannot catch a comforting sentence.
 */
const RECRUITMENT_SRC = join(__dirname, "..");

const BANNED: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /"PUBLISHED"/, why: "a board never confirmed a posting" },
  { pattern: /"SYNC_INITIATED"/, why: "no sync was initiated with anyone" },
  { pattern: /will appear in the ATS pipeline shortly/i, why: "nothing is coming" },
];

/**
 * Comments are stripped before matching. A comment recording that the literal
 * used to be returned here is documentation; the defect was what the endpoint
 * put on the wire. Without this, explaining the fix would fail the gate that
 * checks it.
 */
function executableSource(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* sources(full);
    else if (entry.endsWith(".ts") && !entry.endsWith(".spec.ts")) yield full;
  }
}

describe("board distribution says nothing it cannot back", () => {
  it.each(BANNED)("never claims $why", ({ pattern }) => {
    const offenders: string[] = [];
    for (const file of sources(RECRUITMENT_SRC))
      if (pattern.test(executableSource(file))) offenders.push(file.replace(RECRUITMENT_SRC, ""));
    expect(offenders).toEqual([]);
  });
});
