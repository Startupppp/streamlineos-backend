import postgres from "postgres";

/**
 * The enabling mechanism for every `*.db.spec.ts` in `src/`.
 *
 * These suites used to open with `process.env.INV_DB_TESTS === "1"`, a variable
 * set in no workflow, no `.env.example` and no package script — so all nine of
 * them were `describe.skip` in every run this repository could perform, and
 * reported as a silent green inside `pnpm test`. A gate that has never run is
 * not evidence, and the failure mode was invisible: nothing in the output said
 * the suites had been skipped.
 *
 * The rule now is presence, not a flag: a real-database suite runs when the
 * connection string it needs is in the environment, and says so loudly when it
 * is not. That is the same shape as `test/helpers/db-describe.ts` and as the
 * seeded e2e tier, and it means the run either exercises the database or names
 * the variable that would have let it.
 *
 * The environment is read directly and `.env` is never loaded as a fallback.
 * `.env` here points at a shared Neon branch other sessions are live on, and a
 * tier that creates roles, writes fixtures and drops scratch tables must never
 * attach to a database the caller did not name on purpose.
 */

type Suite = (name: string, fn: () => void) => void;

/** Same rule as `resolvePoolConfig`: TLS to Neon, plain to anything else. */
const NEON_HOST = /\.neon\.tech/i;

export type DbSpecVariable = "DATABASE_URL" | "APP_DATABASE_URL";

export type DbSpecOptions = NonNullable<Parameters<typeof postgres>[1]>;

function present(name: DbSpecVariable): boolean {
  return Boolean(process.env[name]?.trim());
}

/**
 * `describe` when every named variable is set, a loud `describe.skip` otherwise.
 *
 * The reason travels in the suite name as well as on stderr, so a skipped suite
 * is legible in the jest summary and not only in the scrollback.
 */
export function dbSpecSuite(
  required: readonly DbSpecVariable[] = ["DATABASE_URL"],
): Suite {
  const missing = required.filter((name) => !present(name));
  if (missing.length === 0) return describe;
  return (name, fn) => {
    process.stderr.write(
      `\nSKIPPED (no database): "${name}" — set ${missing.join(" and ")} to run it\n`,
    );
    describe.skip(`${name} [skipped: ${missing.join(", ")} not set]`, fn);
  };
}

/**
 * The connection string, or a message naming what to set.
 *
 * Falls through the list in order, so a spec that can use either role states
 * its preference by the order it asks.
 */
export function dbSpecUrl(...preference: readonly DbSpecVariable[]): string {
  const names = preference.length > 0 ? preference : (["DATABASE_URL"] as const);
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  throw new Error(
    `${names.join(" or ")} must be set to run this real-database spec`,
  );
}

function normalize(raw: string): URL {
  const url = new URL(raw);
  url.searchParams.delete("channel_binding");
  return url;
}

/**
 * A client whose TLS setting comes from the host rather than from a constant.
 *
 * Four of these specs hardcoded `ssl: "require"`, which is correct for Neon and
 * fatal everywhere else: against a local Postgres every one of them died with
 * "Client network socket disconnected before secure TLS connection was
 * established" before reaching an assertion. That made the tier unrunnable on
 * exactly the disposable databases CI would have to use.
 */
export function dbSpecClient(
  raw: string,
  options: DbSpecOptions = {},
): ReturnType<typeof postgres> {
  const url = normalize(raw);
  return postgres(url.toString(), {
    prepare: false,
    connect_timeout: 30,
    onnotice: () => undefined,
    ...(NEON_HOST.test(url.hostname) ? { ssl: "require" as const } : {}),
    ...options,
  });
}

/**
 * A session-mode client, for `SET ROLE` and `CREATE TEMP TABLE`.
 *
 * Neon encodes session mode in the host; elsewhere the substitution is a no-op
 * because no host carries `-pooler.`.
 */
export function dbSpecSessionClient(
  raw: string,
  options: DbSpecOptions = {},
): ReturnType<typeof postgres> {
  return dbSpecClient(raw.replace("-pooler.", "."), { max: 1, ...options });
}
