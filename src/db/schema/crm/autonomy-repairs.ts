import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, boolean, index, uniqueIndex, unique } from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";

/**
 * What the system is allowed to fix without asking, and every value it changed.
 *
 * The list below is the whole point of this file. A repair happens with nobody
 * watching, so the set of things that may be repaired has to be a closed,
 * stated enumeration rather than a capability that grows whenever somebody adds
 * a producer — the moment "auto-repairable" becomes a property a caller can
 * assert about its own work, the guarantee is gone.
 *
 * Three admission tests, and a class is in the list only if it passes all three:
 *
 * **Deterministic** — the same input always yields the same output, computed by
 * a pure function with no model, no threshold and no tenant-specific tuning.
 *
 * **Reversible** — the value it replaced is recorded before the write, so one
 * statement puts it back.
 *
 * **Unambiguous** — there is exactly one candidate repair. This is the test that
 * excludes the interesting cases: a merge chooses which of two records survives
 * and which of two spellings of an address is right, and a phone number missing
 * its country code could be any of two hundred countries. Those are choices
 * between plausible alternatives, and a choice is a human's.
 */
export const REPAIR_CLASSES = [
  /**
   * An e-mail address carrying whitespace that cannot be part of an address.
   *
   * Deliberately NOT in the conservative set. Deleting a space is only safe
   * where the space sits somewhere an address cannot contain one anyway; a space
   * *inside* the local part might have stood in for a dot, and `johnsmith@` and
   * `john.smith@` are different mailboxes. The proposal refuses that case
   * outright, and the class still defaults to off, because a tenant who imports
   * from a source that mangles addresses should say so before the system starts
   * rewriting them.
   */
  "email.whitespace",
  /**
   * A domain that begins or ends in a dot.
   *
   * Conservative. A dot cannot begin a domain and a trailing dot is the DNS root
   * label, so removing it names the same host — the repair re-spells the value
   * without changing which mailbox it denotes.
   */
  "email.domain-dot-edge",
  /**
   * A phone number written with characters outside ASCII.
   *
   * Conservative. Fullwidth and Arabic-Indic digits, non-breaking spaces and
   * typographic dashes all have exactly one ASCII equivalent, so the mapping is
   * one-to-one and the digits are unchanged. A value whose non-ASCII characters
   * are not in that closed table, or whose digits do not come out dialable, is
   * refused — the second case is precisely where "the country code is missing"
   * begins, and that is a choice.
   */
  "phone.non-ascii-characters",
] as const;
export type RepairClass = (typeof REPAIR_CLASSES)[number];

/**
 * Whether one organisation lets the system repair one class unattended.
 *
 * A row is an override. Absence is not "off" and not "on" — it is "whatever the
 * platform says the conservative default for this class is", which is how a
 * tenant that has never opened the screen behaves identically to one that
 * explicitly chose the defaults. `autonomy_settings` resolves its dials the same
 * way and for the same reason.
 *
 * Deliberately a second table rather than a widening of `autonomy_switches`. A
 * switch is a veto over something that is on by default — the product's premise
 * is that it acts — whereas this is a grant over something that is off unless
 * the enumeration says otherwise. Folding an opt-in into a table whose whole
 * resolution rule is "nothing turned it off, so it is allowed" would invert the
 * default for every reader of that table.
 */
export const autonomyRepairPolicies = pgTable(
  "autonomy_repair_policies",
  {
    autonomyRepairPolicyId: text("autonomy_repair_policy_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),

    repairClass: text("repair_class").$type<RepairClass>().notNull(),
    enabled: boolean("enabled").notNull(),
    /** Why the tenant said so, for whoever asks in six months. */
    reason: text("reason"),

    /** Plain text, never a foreign key to `users`: see 0223. */
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    /** One answer per class per tenant. This is the upsert target. */
    uniqueIndex("uniq_autonomy_repair_policies_class").on(t.organizationId, t.repairClass),
  ],
);

/**
 * One field, on one record, that the system rewrote on its own.
 *
 * The batch lives in `autonomous_decisions` — one row, however many values it
 * covered, so four hundred identical malformed numbers are reviewed once and
 * counted once. This table is what makes that batch undoable *item by item* as
 * well as whole: the decision names the reversal, and these rows carry the
 * before-values it replays.
 *
 * Both halves are load-bearing. Without the decision, four hundred repairs would
 * be four hundred entries burying every judgement in the review feed. Without
 * these rows, a manager who agrees with three hundred and ninety-nine of them
 * would have to undo all four hundred to fix the one.
 */
export const autonomyRepairs = pgTable(
  "autonomy_repairs",
  {
    autonomyRepairId: text("autonomy_repair_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),

    /** The batch this belongs to, and the row the review feed shows. */
    autonomousDecisionId: text("autonomous_decision_id").notNull(),
    repairClass: text("repair_class").$type<RepairClass>().notNull(),

    /** The queue item this closed, so reverting can put it back. */
    findingId: text("finding_id"),
    partyId: text("party_id").notNull(),
    /** The column rewritten, named as the party table spells it. */
    field: text("field").notNull(),

    /**
     * What was there before, captured at the moment of the write.
     *
     * Nullable because the column it mirrors is, and because an undo has to be
     * able to restore an absence. Reconstructing this afterwards from the
     * record's history cannot tell what the system replaced from what a person
     * typed since — the same reasoning `party_merges` snapshots both rows for.
     */
    previousValue: text("previous_value"),
    repairedValue: text("repaired_value"),

    appliedAt: timestamp("applied_at").defaultNow().notNull(),

    /** Set when a human took this one value back, individually or in its batch. */
    revertedAt: timestamp("reverted_at"),
    /** Plain text, never a foreign key to `users`: see 0223. */
    revertedByUserId: text("reverted_by_user_id"),
    revertedReason: text("reverted_reason"),
  },
  (t) => [
    /** The batch's own read: everything one decision changed, and the undo's set. */
    index("idx_autonomy_repairs_decision").on(t.organizationId, t.autonomousDecisionId),
    /** The measure: how much was repaired, per class, over a window. */
    index("idx_autonomy_repairs_class").on(t.organizationId, t.repairClass, t.appliedAt),
    /** What the system changed on one record, for that record's own screen. */
    index("idx_autonomy_repairs_party").on(t.organizationId, t.partyId, t.appliedAt),
    /** What is still standing, which is what a batch reversal has to find. */
    index("idx_autonomy_repairs_live")
      .on(t.organizationId, t.autonomousDecisionId)
      .where(sql`reverted_at is null`),
    /** The composite tenant key anything pointing back at a repair needs. */
    unique("uniq_autonomy_repairs_org_id").on(t.organizationId, t.autonomyRepairId),
  ],
);
