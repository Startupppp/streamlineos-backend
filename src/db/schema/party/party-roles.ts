import { randomUUID } from "node:crypto";
import {
  pgTable,
  text,
  timestamp,
  jsonb,
  doublePrecision,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "../common/auth";

/**
 * What a party is to this organisation.
 *
 * A row per role rather than a column, because one company is routinely both a
 * customer and a supplier, and modelling that as a single type forces a second
 * record for the same business — which is the duplication the merge machinery
 * then has to undo. Acquiring a role is an insert; it never creates a party.
 */
export const partyRoles = pgTable(
  "party_roles",
  {
    partyRoleId: text("party_role_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    partyId: text("party_id").notNull(),
    /** CUSTOMER · VENDOR · PARTNER · PROSPECT · and whatever a tenant adds. */
    role: text("role").notNull(),
    assignedBy: text("assigned_by"),
    assignedAt: timestamp("assigned_at").defaultNow().notNull(),
    removedAt: timestamp("removed_at"),
  },
  (t) => [
    uniqueIndex("uniq_party_roles_party_role").on(t.organizationId, t.partyId, t.role),
    // Filtering the list by role, which is the read this table exists for.
    index("idx_party_roles_org_role").on(t.organizationId, t.role, t.partyId),
  ],
);

/**
 * A merge that happened, and everything needed to undo it.
 *
 * The snapshot is the whole point. A merge that cannot be reversed is a
 * destructive operation dressed as a convenience, and the system performs some
 * of them without asking — so both records are captured verbatim beforehand,
 * along with exactly what moved.
 */
export const partyMerges = pgTable(
  "party_merges",
  {
    partyMergeId: text("party_merge_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    survivorPartyId: text("survivor_party_id").notNull(),
    mergedPartyId: text("merged_party_id").notNull(),

    /** SYSTEM for an automatic merge, USER when a human confirmed one. */
    decidedBy: text("decided_by").notNull(),
    decidedByUserId: text("decided_by_user_id"),
    confidence: doublePrecision("confidence"),
    /** Which comparisons agreed, so the record says why this happened. */
    signals: jsonb("signals").$type<string[]>(),

    /**
     * Fields present on both sides with different values. Kept rather than
     * dropped: the survivor's value won, and the other one is still evidence.
     */
    conflicts: jsonb("conflicts").$type<Record<string, { kept: unknown; discarded: unknown }>>(),

    /** Both rows verbatim plus what moved, so a revert restores exactly. */
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),

    mergedAt: timestamp("merged_at").defaultNow().notNull(),
    revertedAt: timestamp("reverted_at"),
    revertedByUserId: text("reverted_by_user_id"),
  },
  (t) => [
    index("idx_party_merges_org_survivor").on(t.organizationId, t.survivorPartyId, t.mergedAt),
    // A record can only be the loser of one live merge.
    uniqueIndex("uniq_party_merges_merged_live")
      .on(t.organizationId, t.mergedPartyId)
      .where(sql`reverted_at is null`),
  ],
);

/**
 * Pairs a human still has to judge.
 *
 * Everything the detector considered plausible but would not merge on its own
 * lands here rather than being guessed at or silently dropped.
 */
export const partyDuplicateCandidates = pgTable(
  "party_duplicate_candidates",
  {
    candidateId: text("candidate_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    /** Ordered so a pair cannot be queued twice under two arrangements. */
    lowPartyId: text("low_party_id").notNull(),
    highPartyId: text("high_party_id").notNull(),
    score: doublePrecision("score").notNull(),
    signals: jsonb("signals").$type<string[]>(),
    blockers: jsonb("blockers").$type<string[]>(),
    /** PENDING · MERGED · DISMISSED */
    status: text("status").notNull().default("PENDING"),
    detectedAt: timestamp("detected_at").defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at"),
    resolvedByUserId: text("resolved_by_user_id"),
  },
  (t) => [
    uniqueIndex("uniq_party_duplicate_pair").on(t.organizationId, t.lowPartyId, t.highPartyId),
    index("idx_party_duplicate_queue").on(t.organizationId, t.status, t.score),
  ],
);
