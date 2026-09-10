import type { SQL } from "drizzle-orm";

export type DataScope = "all" | "team" | "own" | "none";

// A DataScope spent into a predicate. A name, not a proof — check-scope-application.mjs enforces it.
export type ScopePredicate = SQL;
