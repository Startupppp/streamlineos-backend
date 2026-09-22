import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const VERIFY_SQL = join(REPO_ROOT, "migrations", "sql", "b-qa-bug-03-verify.sql");

const EXPECTED_CHECK_COUNT = 14;

const PRODUCTION_HOST_PATTERNS = [
  /\.rds\.amazonaws\.com$/i,
  /\.neon\.tech$/i,
  /\.amazonaws\.com$/i,
  /^streamlineos[-.]/i,
];

class Refusal extends Error {}

export function parseChecks(sqlText) {
  const checks = [];
  for (const raw of sqlText.split(/-->\s*statement-breakpoint/)) {
    const statement = raw
      .split(/\r?\n/)
      .filter((line) => !/^\s*--/.test(line))
      .join("\n")
      .trim();
    if (statement.length === 0) continue;
    const named = /^SELECT\s+count\(\*\)\s+AS\s+([a-z_][a-z0-9_]*)/i.exec(statement);
    if (!named) continue;
    checks.push({ name: named[1], sql: statement.replace(/;\s*$/, "") });
  }
  return checks;
}

function envFileHosts(root) {
  const hosts = new Set();
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    return hosts;
  }
  for (const entry of entries) {
    if (!entry.startsWith(".env") || entry.endsWith(".example")) continue;
    const full = join(root, entry);
    if (!existsSync(full)) continue;
    let text;
    try {
      text = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    for (const match of text.matchAll(/postgres(?:ql)?:\/\/[^\s"'\r\n]+/gi)) {
      try {
        hosts.add(new URL(match[0]).hostname.toLowerCase());
      } catch {
        continue;
      }
    }
  }
  return hosts;
}

export function resolveTargetUrl(argv, options = {}) {
  const root = options.root ?? REPO_ROOT;
  let raw = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url") raw = argv[i + 1] ?? null;
    else if (arg.startsWith("--url=")) raw = arg.slice("--url=".length);
  }

  if (raw === null || raw.trim() === "")
    throw new Refusal(
      "verify:qa-bug-contraction refuses to run without an explicit --url. " +
        "It never reads .env, because .env and .env.production both resolve to the production Aurora host. " +
        "Pass --url postgres://user:pass@host:port/db pointing at a disposable database.",
    );

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Refusal(`verify:qa-bug-contraction refuses an unparseable --url: ${raw}`);
  }

  if (!/^postgres(ql)?:$/i.test(parsed.protocol))
    throw new Refusal(`verify:qa-bug-contraction refuses a non-postgres --url scheme: ${parsed.protocol}`);

  const host = parsed.hostname.toLowerCase();

  for (const pattern of PRODUCTION_HOST_PATTERNS)
    if (pattern.test(host))
      throw new Refusal(
        `verify:qa-bug-contraction refuses to connect to ${host}: it matches a production host pattern (${pattern}). ` +
          "These 14 checks are read-only, but nothing in this repository may point a runner at production by default.",
      );

  const configured = envFileHosts(root);
  if (configured.has(host))
    throw new Refusal(
      `verify:qa-bug-contraction refuses to connect to ${host}: it is the host configured in this checkout's .env files, ` +
        "which resolve to production.",
    );

  return { url: raw, host };
}

function selfTest() {
  const failures = [];
  const expect = (label, condition) => {
    if (!condition) failures.push(label);
  };
  const refuses = (argv, root) => {
    try {
      resolveTargetUrl(argv, { root });
      return null;
    } catch (error) {
      return error instanceof Refusal ? error.message : `threw non-Refusal: ${error}`;
    }
  };

  const noEnvRoot = join(HERE, "__no_env_fixture__");

  expect("no --url must be refused", refuses([], noEnvRoot) !== null);
  expect("an empty --url must be refused", refuses(["--url", ""], noEnvRoot) !== null);
  expect(
    "an rds.amazonaws.com host must be refused",
    refuses(["--url", "postgres://u:p@streamlineos-instance-1.c94aokgu6g21.ap-south-1.rds.amazonaws.com:5432/streamlineos"], noEnvRoot) !== null,
  );
  expect(
    "a neon.tech host must be refused",
    refuses(["--url", "postgres://u:p@ep-cool-name.ap-southeast-1.aws.neon.tech/main"], noEnvRoot) !== null,
  );
  expect(
    "a non-postgres scheme must be refused",
    refuses(["--url", "https://example.invalid/db"], noEnvRoot) !== null,
  );
  expect("an unparseable --url must be refused", refuses(["--url", "not a url"], noEnvRoot) !== null);

  let accepted = null;
  try {
    accepted = resolveTargetUrl(["--url=postgres://u:p@127.0.0.1:5432/scratch"], { root: noEnvRoot });
  } catch (error) {
    failures.push(`a loopback --url must be accepted, but was refused: ${error.message}`);
  }
  expect("an accepted --url must report its host", accepted?.host === "127.0.0.1");
  expect(
    "--url and --url= must resolve identically",
    resolveTargetUrl(["--url", "postgres://u:p@127.0.0.1:5432/scratch"], { root: noEnvRoot }).url ===
      accepted?.url,
  );

  const fixtureRoot = mkdtempSync(join(tmpdir(), "qa-bug-contraction-"));
  writeFileSync(
    join(fixtureRoot, ".env"),
    'DATABASE_URL="postgres://app:secret@configured-host.example:5432/streamlineos"\n',
  );
  writeFileSync(join(fixtureRoot, ".env.example"), 'DATABASE_URL="postgres://u:p@example-only.invalid:5432/db"\n');
  expect(
    "a host named only by a .env in the checkout must be refused even though it matches no production pattern",
    refuses(["--url", "postgres://u:p@configured-host.example:5432/db"], fixtureRoot) !== null,
  );
  expect(
    "a host named only by .env.example must not be refused, because .env.example carries no live credential",
    refuses(["--url", "postgres://u:p@example-only.invalid:5432/db"], fixtureRoot) === null,
  );
  expect(
    "the same URL must be accepted under a root with no .env, proving the refusal came from the .env and not the URL",
    refuses(["--url", "postgres://u:p@configured-host.example:5432/db"], noEnvRoot) === null,
  );
  rmSync(fixtureRoot, { recursive: true, force: true });

  const hostsFromThisCheckout = envFileHosts(REPO_ROOT);
  for (const host of hostsFromThisCheckout)
    expect(
      `a host named by this checkout's .env (${host}) must be refused`,
      refuses(["--url", `postgres://u:p@${host}:5432/db`], REPO_ROOT) !== null,
    );

  const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const dotenvImport = new RegExp(`(?:from|require\\()\\s*["']${["dot", "env"].join("")}`);
  expect("this runner must never import dotenv", !dotenvImport.test(source));
  const envAccess = new RegExp(["process", "env"].join("\\."), "g");
  expect(
    "this runner must never read a connection string out of the environment",
    [...source.matchAll(envAccess)].length === 0,
  );

  const sqlText = readFileSync(VERIFY_SQL, "utf8");
  const checks = parseChecks(sqlText);
  expect(
    `the runner must parse ${EXPECTED_CHECK_COUNT} checks out of b-qa-bug-03-verify.sql, found ${checks.length}`,
    checks.length === EXPECTED_CHECK_COUNT,
  );
  expect("every parsed check must be named", checks.every((c) => typeof c.name === "string" && c.name.length > 0));
  expect("check names must be unique", new Set(checks.map((c) => c.name)).size === checks.length);
  expect(
    "every parsed check must carry the SELECT it will run",
    checks.every((c) => /^SELECT\s+count\(\*\)/i.test(c.sql)),
  );
  expect(
    "the informational distribution query must not be scored as an assertion",
    !checks.some((c) => c.name === "rows"),
  );

  const oneRemoved = parseChecks(sqlText.replace(/SELECT count\(\*\) AS unmapped_bugs/, "SELECT 1 AS not_a_check"));
  expect(
    `removing one assertion must drop the parsed count to ${EXPECTED_CHECK_COUNT - 1}, got ${oneRemoved.length}`,
    oneRemoved.length === EXPECTED_CHECK_COUNT - 1,
  );
  expect("parsing empty SQL must yield no checks", parseChecks("").length === 0);

  if (failures.length > 0) {
    console.error("verify-qa-bug-contraction self-test FAILED:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(3);
  }
  console.log(
    `verify-qa-bug-contraction self-test passed: ${checks.length} checks parsed, ` +
      `${hostsFromThisCheckout.size} configured host(s) refused, refusal holds on 6 hostile inputs`,
  );
}

async function run(target, checks) {
  const { default: postgres } = await import("postgres");
  const sql = postgres(target.url, { max: 1, prepare: false, onnotice: () => {} });
  const results = [];
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET TRANSACTION READ ONLY");
      for (const check of checks) {
        const [row] = await tx.unsafe(check.sql);
        results.push({ name: check.name, count: Number(Object.values(row ?? {})[0] ?? 0) });
      }
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
  return results;
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes("--self-test")) {
    selfTest();
    return;
  }

  let target;
  try {
    target = resolveTargetUrl(argv);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    console.error(error.message);
    process.exit(2);
  }

  const checks = parseChecks(readFileSync(VERIFY_SQL, "utf8"));
  if (checks.length !== EXPECTED_CHECK_COUNT) {
    console.error(
      `verify-qa-bug-contraction: parsed ${checks.length} checks out of b-qa-bug-03-verify.sql but expected ` +
        `${EXPECTED_CHECK_COUNT}. A pass here would be vacuous; fix the parser or the expectation, not the SQL.`,
    );
    process.exit(2);
  }

  console.log(`verify-qa-bug-contraction: running ${checks.length} read-only checks against ${target.host}`);
  const results = await run(target, checks);

  let failed = 0;
  for (const result of results) {
    const ok = result.count === 0;
    if (!ok) failed += 1;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${result.name} = ${result.count}`);
  }

  if (results.length !== EXPECTED_CHECK_COUNT) {
    console.error(
      `verify-qa-bug-contraction: ran ${results.length} of ${EXPECTED_CHECK_COUNT} checks — incomplete, not a pass.`,
    );
    process.exit(2);
  }

  if (failed > 0) {
    console.error(
      `verify-qa-bug-contraction: ${failed} of ${results.length} checks are non-zero. ` +
        "The QA bug contraction is blocked until every one of them reads 0.",
    );
    process.exit(1);
  }

  console.log(`verify-qa-bug-contraction: all ${results.length} checks read 0.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
