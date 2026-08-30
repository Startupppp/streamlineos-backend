import { randomUUID } from "node:crypto";
import { pgTable, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";

export const dealStageTransitions = pgTable(
  "deal_stage_transitions",
  {
    dealStageTransitionId: text("deal_stage_transition_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    dealId: integer("deal_id").notNull(),
    pipelineId: text("pipeline_id"),
    fromStage: text("from_stage"),
    toStage: text("to_stage").notNull(),
    actorKind: text("actor_kind").notNull(),
    actorUserId: text("actor_user_id"),
    actorLabel: text("actor_label"),
    reason: text("reason"),
    occurredAt: timestamp("occurred_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_deal_stage_transitions_deal").on(
      table.organizationId,
      table.dealId,
      table.occurredAt,
    ),
    index("idx_deal_stage_transitions_actor").on(
      table.organizationId,
      table.actorKind,
      table.occurredAt,
    ),
  ],
);
