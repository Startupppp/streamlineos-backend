import type { SQL } from "drizzle-orm";

export type DataScope = "all" | "team" | "own" | "none";

// A DataScope spent into a predicate. Built only by ScopedRead — ADR 0005.
export type ScopePredicate = SQL;
