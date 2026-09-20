import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "../..");
const SRC = join(ROOT, "src");

const ALLOWED = new Map();

const MIN_EXPECTED_CALLS = 8;

const SKIP_DIRS = new Set(["node_modules", "dist", "migrations", "__tests__", "scripts"]);

function isScannable(path) {
  if (extname(path) !== ".ts") return false;
  return !/\.(spec|e2e-spec|test|d)\.ts$/.test(path);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (isScannable(full)) out.push(full);
  }
  return out;
}

const DECLARES_OWN_FETCH =
  /(?:\b(?:const|let|var|function)\s+fetch\b)|(?:\bfetch\s*[:?]\s*\()|(?:\bfetch\s*:\s*\(\w)/;

const DECLARATION_PREFIX = /\b(?:function|async|private|public|protected|static|get|set)\s*$/;

export function findFetchCalls(source) {
  const calls = [];
  if (DECLARES_OWN_FETCH.test(source)) return calls;

  const pattern = /(?<![\w.$-])fetch\s*\(/g;
  let match;

  while ((match = pattern.exec(source)) !== null) {
    if (DECLARATION_PREFIX.test(source.slice(Math.max(0, match.index - 24), match.index)))
      continue;

    const open = match.index + match[0].length - 1;
    let depth = 0;
    let end = -1;
    let quote = null;

    for (let i = open; i < source.length; i++) {
      const ch = source[i];
      const prev = source[i - 1];
      if (quote) {
        if (ch === quote && prev !== "\\") quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        continue;
      }
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) continue;

    const args = source.slice(open + 1, end);
    if (args.trim() === "") continue;

    calls.push({
      line: source.slice(0, match.index).split("\n").length,
      args,
      hasSignal: /\bsignal\s*:/.test(args) || /\.\.\.\s*\w+/.test(args),
    });
  }

  return calls;
}

function scan() {
  const files = walk(SRC);
  const violations = [];
  let total = 0;

  for (const file of files) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    for (const call of findFetchCalls(readFileSync(file, "utf8"))) {
      total++;
      if (call.hasSignal) continue;
      const key = `${rel}:${call.line}`;
      if (ALLOWED.has(key)) continue;
      violations.push(key);
    }
  }

  return { total, violations, files: files.length };
}

function selfTest() {
  const failures = [];

  const unbounded = findFetchCalls(`await fetch("https://api.example.com/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });`);
  if (unbounded.length !== 1) failures.push("did not find an unbounded global fetch");
  else if (unbounded[0].hasSignal) failures.push("called an unbounded fetch bounded");

  const bounded = findFetchCalls(
    `await fetch(url, { method: "POST", signal: AbortSignal.timeout(10_000) });`,
  );
  if (bounded.length !== 1) failures.push("did not find a bounded global fetch");
  else if (!bounded[0].hasSignal) failures.push("called a bounded fetch unbounded");

  const method = findFetchCalls(`const rows = await this.fetch(afterId, 500);
    const more = await input.fetch(cursor);`);
  if (method.length !== 0) failures.push(`counted a .fetch() method as a global fetch (${method.length})`);

  const uaRegex = findFetchCalls(`test: (ua) => /^node-fetch(?:\\/|$)/i.test(ua),`);
  if (uaRegex.length !== 0) failures.push("counted a node-fetch user-agent regex as a call");

  const declaration = findFetchCalls(`  private async fetch(
    composioAccountId: string,
  ): Promise<void> {}`);
  if (declaration.length !== 0) failures.push("counted a method declaration as a call");

  const zeroArg = findFetchCalls(`const fetchRows = async () => rows;
    return somethingElse();
    if (x) return handler();`);
  if (zeroArg.length !== 0) failures.push("counted an unrelated zero-arg call");

  const shadowed = findFetchCalls(`const fetch = () => this.load();
    if (!filters) return fetch();
    return this.cache.cached(key, fetch, TTL);`);
  if (shadowed.length !== 0) failures.push("counted a locally-bound fetch as the global one");

  const nested = findFetchCalls(`await fetch(buildUrl({ a: (1 + 2) }), { signal: ctrl.signal });`);
  if (nested.length !== 1) failures.push("lost a call with nested parentheses in its arguments");
  else if (!nested[0].hasSignal) failures.push("missed a signal after nested parentheses");

  const stringParen = findFetchCalls(`await fetch("https://x/y?a=(b)", { method: "GET" });`);
  if (stringParen.length !== 1) failures.push("lost a call with a parenthesis inside a string");
  else if (stringParen[0].hasSignal) failures.push("called a string-paren call bounded");

  const live = scan();
  if (live.total < MIN_EXPECTED_CALLS)
    failures.push(`scan reached only ${live.total} calls, below the ${MIN_EXPECTED_CALLS} floor`);

  return failures;
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes("--self-test")) {
    const failures = selfTest();
    if (failures.length > 0) {
      console.error("check-outbound-timeouts self-test FAILED:");
      for (const failure of failures) console.error(`  - ${failure}`);
      process.exit(3);
    }
    console.log("check-outbound-timeouts self-test passed");
    return;
  }

  const result = scan();

  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    if (result.violations.length > 0) process.exit(1);
    return;
  }

  if (result.total < MIN_EXPECTED_CALLS) {
    console.error(
      `check-outbound-timeouts: scan reached only ${result.total} fetch call(s) across ${result.files} file(s), ` +
        `below the floor of ${MIN_EXPECTED_CALLS}. A zero here would be vacuous — fix the scan, not the floor.`,
    );
    process.exit(2);
  }

  const stale = [...ALLOWED.keys()].filter(
    (key) => !readFileSync(join(ROOT, key.split(":")[0]), "utf8"),
  );
  if (stale.length > 0) {
    console.error("check-outbound-timeouts: ALLOWED entries no longer exist:");
    for (const key of stale) console.error(`  - ${key}`);
    process.exit(1);
  }

  if (result.violations.length > 0) {
    console.error(
      `check-outbound-timeouts: ${result.violations.length} outbound call(s) declare no abort signal.\n` +
        "Every request holds a pooled connection for its whole life, so an unbounded call\n" +
        "stalls the pool, not just its caller. Add `signal: AbortSignal.timeout(ms)`.\n",
    );
    for (const key of result.violations) console.error(`  - ${key}`);
    process.exit(1);
  }

  console.log(
    `check-outbound-timeouts: ${result.total} outbound call(s) across ${result.files} file(s), all bounded.`,
  );
}

main();
