/**
 * The approval gate for every `*.db.spec.ts`.
 *
 * These suites are destructive by design against whatever they connect to:
 * `party-identifiers.db.spec.ts` runs `DROP TABLE IF EXISTS "party_identifiers"
 * CASCADE` and `party-legacy-backfill.db.spec.ts` drops two `business_parties`
 * constraints. They roll the transaction back, but `DROP TABLE`/`ALTER TABLE`
 * take ACCESS EXCLUSIVE on the real table for the duration and a rollback does
 * not undo that outage — nor does it help the day somebody edits one to commit.
 *
 * Until 2026-09-08 each file resolved its own URL with
 * `if (!process.env.DATABASE_URL) dotenv.config({ path: ".env" })`, so
 * `pnpm test:db-specs` with nothing exported silently loaded `backend/.env`,
 * whose `DATABASE_URL` is a remote Neon database. That fallback is deleted and
 * this file replaces it.
 *
 * Two independent conditions, because either alone is defeatable. A hostname
 * check alone cannot see an SSH tunnel or a port-forward that puts a production
 * database on 127.0.0.1 — which is how a workstation normally reaches Neon. An
 * opt-in variable alone survives in a shell that exported it once and then
 * changed the URL. Requiring both means an accident needs two mistakes, and the
 * opt-in makes the operator state destructive intent on the command line.
 *
 * The sweep refuses an unapproved URL even when no spec reads that variable: a
 * process running destructive tests has no business carrying a production URL
 * at all, and the refusal names the variable so it is actionable.
 */

/** Set to `1` by the operator to state that this database may be destroyed. */
export const OPT_IN_VAR = "ALLOW_DESTRUCTIVE_DB_TESTS";

/** Comma-separated extra hosts, for a container or a CI service by name. */
export const ALLOWED_HOSTS_VAR = "DB_SPEC_ALLOWED_HOSTS";

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "::1",
  "0:0:0:0:0:0:0:1",
  "localhost",
  "localhost.localdomain",
]);

/**
 * Which environment variables are treated as a database this run could damage.
 * Every name a `.db.spec.ts` reads today ends in `DATABASE_URL`; the other two
 * spellings are here so a future variable is caught by shape rather than by
 * somebody remembering to add it.
 */
const URL_VAR_PATTERN = /(?:DATABASE_URL|POSTGRES_URL|DB_URL)$/;

export type UrlVerdict =
  | { readonly ok: true; readonly url: string; readonly target: string }
  | { readonly ok: false; readonly target: string; readonly because: string };

/** Host, port and database only — never the password, which is in the URL. */
function describeTarget(raw: string): string {
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const port = url.port || "5432";
    const database = url.pathname.replace(/^\//, "") || "(none)";
    return `${host}:${port}/${database}`;
  } catch {
    return "(unparseable URL)";
  }
}

function allowedHosts(env: NodeJS.ProcessEnv): ReadonlySet<string> {
  const extra = (env[ALLOWED_HOSTS_VAR] ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host.length > 0);
  return new Set([...LOOPBACK_HOSTS, ...extra]);
}

function hostList(env: NodeJS.ProcessEnv): string {
  return [...allowedHosts(env)].join(", ");
}

/** Whether one URL names a database this process may destroy. */
export function checkDatabaseUrl(raw: string, env: NodeJS.ProcessEnv = process.env): UrlVerdict {
  const target = describeTarget(raw);

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, target, because: "the value is not a parseable URL" };
  }

  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!allowedHosts(env).has(host))
    return {
      ok: false,
      target,
      because:
        `host "${host}" is not approved for destructive testing ` +
        `(approved: ${hostList(env)})`,
    };

  if (env[OPT_IN_VAR] !== "1")
    return {
      ok: false,
      target,
      because: `${OPT_IN_VAR} is not set to "1", so no database is approved for destruction`,
    };

  return { ok: true, url: raw, target };
}

function refusal(lines: readonly string[], env: NodeJS.ProcessEnv): Error {
  return new Error(
    [
      "",
      "REFUSED: .db.spec.ts suites are DESTRUCTIVE (DROP TABLE, ALTER TABLE, fixture writes)",
      "and this process is not pointed at a database approved for that.",
      "",
      ...lines,
      "",
      "To run them:",
      "  1. Point every *DATABASE_URL in the environment at a database you are willing to lose,",
      "     e.g. DATABASE_URL=postgresql://neondb_owner@127.0.0.1:5432/scratch_local",
      `  2. Set ${OPT_IN_VAR}=1 in the same command.`,
      "",
      `Approved hosts: ${hostList(env)}`,
      `Add more with ${ALLOWED_HOSTS_VAR}=host,host — never a production hostname.`,
      "There is no .env fallback: an unset URL refuses rather than loading backend/.env,",
      "whose DATABASE_URL is the remote Neon database.",
      "",
    ].join("\n"),
  );
}

/** Refuses unless `raw` names an approved database. Returns it when it does. */
export function assertApprovedDatabaseUrl(
  varName: string,
  raw: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const verdict = checkDatabaseUrl(raw, env);
  if (verdict.ok) return verdict.url;
  throw refusal([`  ${varName} -> ${verdict.target}`, `  refused: ${verdict.because}`], env);
}

/**
 * The URL a spec should connect with, from the first of `vars` that is set.
 *
 * Replaces the per-file `if (!process.env.DATABASE_URL) dotenv.config(...)`.
 * An unset variable refuses here; it never falls back to a file on disk.
 */
export function requireApprovedDatabaseUrl(options: {
  readonly spec: string;
  readonly vars: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}): string {
  const env = options.env ?? process.env;
  for (const varName of options.vars) {
    const raw = env[varName];
    if (raw && raw.trim().length > 0) return assertApprovedDatabaseUrl(varName, raw.trim(), env);
  }
  throw refusal(
    [
      `  ${options.spec} needs one of: ${options.vars.join(", ")}`,
      "  refused: none of them is set",
    ],
    env,
  );
}

/**
 * Every database URL in the environment, checked before any suite runs.
 *
 * Registered as the first `setupFiles` entry of `jest-db.json`, so it covers
 * every `*.db.spec.ts` the config selects — including one added tomorrow that
 * never calls `requireApprovedDatabaseUrl`.
 */
export function assertDbSpecEnvironmentApproved(env: NodeJS.ProcessEnv = process.env): void {
  const present = Object.keys(env)
    .filter((name) => URL_VAR_PATTERN.test(name))
    .filter((name) => (env[name] ?? "").trim().length > 0)
    .sort();

  if (present.length === 0)
    throw refusal(
      ["  no *DATABASE_URL is set in this environment", "  refused: nothing to run against"],
      env,
    );

  const refused: string[] = [];
  for (const name of present) {
    const verdict = checkDatabaseUrl((env[name] ?? "").trim(), env);
    if (!verdict.ok) refused.push(`  ${name} -> ${verdict.target}\n  refused: ${verdict.because}`);
  }
  if (refused.length > 0) throw refusal(refused, env);
}
