import type { Db } from "../../../db/drizzle.module";

export interface TierDbState {
  row: Record<string, unknown>;
  reads: number;
}

export interface TierDbDouble {
  db: Db;
  state: TierDbState;
  release: () => void;
}

/**
 * A database whose single `subscriptions` row can be changed between reads, counting every tenant
 * transaction that actually reached it. `queryTier` opens exactly one per miss, so the transaction
 * count is the miss count. `gated` parks every read until `release()` is called, which is how a
 * fill can still be in flight when an invalidation lands.
 */
export function makeTierDb(
  initial: Record<string, unknown>,
  options: { gated?: boolean } = {},
): TierDbDouble {
  const state: TierDbState = { row: initial, reads: 0 };
  let unblock: () => void = () => undefined;
  const gate =
    options.gated === true
      ? new Promise<void>((resolve) => {
          unblock = resolve;
        })
      : Promise.resolve();

  const db: { execute: () => Promise<unknown[]>; transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> } = {
    execute: async () => {
      await gate;
      return [state.row];
    },
    transaction: (fn) => {
      state.reads += 1;
      return fn(db);
    },
  };

  return { db: db as unknown as Db, state, release: () => unblock() };
}

export const TIER_PAID = {
  plan: "PROFESSIONAL",
  status: "ACTIVE",
  trial_ends_at: null,
  created_at: new Date(),
  current_period_end: null,
};

export const TIER_CANCELLED = {
  plan: "PROFESSIONAL",
  status: "CANCELLED",
  trial_ends_at: null,
  created_at: new Date(),
  current_period_end: null,
};
