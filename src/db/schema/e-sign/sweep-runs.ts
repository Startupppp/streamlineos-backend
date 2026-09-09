import { pgTable, serial, text, integer, timestamp, unique, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "../common/auth";

/**
 * When each sweep last ran for an organisation, and whether it worked.
 *
 * The reminder and expiration sweeps shipped with no scheduler attached and
 * nothing said so — an operator could not tell a sweep that ran and found
 * nothing from one that had never been invoked. `error` matters as much as
 * `ran_at`: a sweep that raises for one tenant must leave a mark on that
 * tenant, or the failure is invisible in exactly the way it was before.
 *
 * One row per (org, sweep). The last run, not a history.
 */
export const signSweepRuns = pgTable(
  "sign_sweep_runs",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    /** 'reminder' | 'expiration' */
    sweep: text("sweep").notNull(),
    ranAt: timestamp("ran_at").defaultNow().notNull(),
    affected: integer("affected").default(0).notNull(),
    /** Null on a clean run; the failure message otherwise. */
    error: text("error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("uniq_sign_sweep_runs_org_sweep").on(t.orgId, t.sweep),
    index("idx_sign_sweep_runs_org").on(t.orgId, t.sweep),
    check("chk_sign_sweep_runs_sweep", sql`${t.sweep} IN ('reminder', 'expiration')`),
  ],
);

export type SignSweepRun = typeof signSweepRuns.$inferSelect;
