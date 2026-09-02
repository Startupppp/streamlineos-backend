export type DisposableTarget =
  | { ok: true; database: string }
  | { ok: false; reason: string };

/**
 * Mirrors the rule `seed-scratch-e2e.mjs` applies to `SCRATCH_DATABASE_URL`: the seeded
 * harness writes and deletes fixture rows, so pointing it at a shared database is data loss.
 */
export function assertDisposableDatabase(url: string): DisposableTarget {
  let database: string;
  try {
    database = new URL(url).pathname.replace(/^\//, "").split("?")[0] ?? "";
  } catch {
    return { ok: false, reason: "DATABASE_URL is not a parseable URL" };
  }
  if (!/scratch/i.test(database))
    return {
      ok: false,
      reason:
        `refusing to run seeded e2e against database "${database}" — it writes and deletes fixture ` +
        `rows, so DATABASE_URL must name a disposable database (its name must contain "scratch"). ` +
        `Build one from DATABASE_URL by replacing the database name with scratch_e2e.`,
    };
  return { ok: true, database };
}
