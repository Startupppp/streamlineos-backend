import postgres from "postgres";
import { resolvePoolConfig, type PoolOptions } from "../db/pool.config";

/**
 * Support for the degradation probes that talk to a real database.
 *
 * Both probes used to decide two things for themselves, and got both wrong.
 *
 * TLS was hardcoded as `ssl: "require"`. postgres.js never reads PGSSLMODE; it
 * honours only an `sslmode` in the URL query string or an explicit `ssl` option,
 * and the explicit option wins over everything. A hardcoded `require` therefore
 * cannot be turned off from the environment, so against any Postgres that does
 * not serve TLS — every local one — the only reachable outcome was a dropped
 * handshake. That is what pinned these suites to the single remote endpoint they
 * were first written against. `resolvePoolConfig` already makes this decision for
 * the running application, so the probes now derive TLS from the URL the same way
 * production does.
 *
 * Which database to reach was left implicit. A spec that reads a connection
 * string out of the ambient environment and connects to whatever it finds is not
 * hermetic: it contends with everyone else pointed at the same host and it fails
 * for reasons that have nothing to do with the code under test. The variable has
 * to be named by the caller, and when it is absent the honest outcome is a skip
 * that says which variable is missing and what the proof needed it for — never a
 * connection attempt to somewhere nobody asked for.
 */

/** Connection options for a probe, with TLS derived from the URL rather than assumed. */
export function probeConnectionOptions(connectionString: string): PoolOptions {
  const { options } = resolvePoolConfig({ APP_DATABASE_URL: connectionString });
  return {
    prepare: false,
    max: 1,
    onnotice: () => {},
    ...(options.ssl === undefined ? {} : { ssl: options.ssl }),
  };
}

/** Opens a single-connection client to `connectionString`, negotiating TLS only if the URL calls for it. */
export function connectForProbe(
  connectionString: string,
  overrides: PoolOptions = {},
): ReturnType<typeof postgres> {
  return postgres(connectionString, {
    ...probeConnectionOptions(connectionString),
    ...overrides,
  });
}

export interface RequiredDatabase {
  /** The connection string the caller supplied, or undefined when the variable is unset. */
  readonly url: string | undefined;
  /** Names the missing variable and what it was needed for; null when the variable is present. */
  readonly blocker: string | null;
  /** The suite title, carrying the named blocker whenever the suite is going to skip. */
  title(name: string): string;
}

/**
 * Reads a database URL that the caller must supply explicitly. `why` should say
 * what the proof cannot demonstrate without it, so a skipped run reports a
 * blocker a reader can act on instead of silently proving nothing.
 */
export function requiredDatabase(
  variable: string,
  why: string,
): RequiredDatabase {
  const url = process.env[variable];
  const blocker = url ? null : `BLOCKED: ${variable} is not set. ${why}`;
  return {
    url,
    blocker,
    title: (name: string) => (blocker ? `${name} — ${blocker}` : name),
  };
}
