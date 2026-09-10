import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";
import { onboardingTasks } from "./onboarding";

export const onboardingTaskDependencies = pgTable(
  "onboarding_task_dependencies",
  {
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    onboardingTaskDependencyId: bigint("onboarding_task_dependency_id", {
      mode: "bigint",
    })
      .generatedAlwaysAsIdentity()
      .notNull(),
    onboardingTaskId: integer("onboarding_task_id").notNull(),
    prerequisiteTaskId: integer("prerequisite_task_id").notNull(),
    sortOrder: integer("sort_order").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: "pk_onboarding_task_dependencies",
      columns: [table.organizationId, table.onboardingTaskDependencyId],
    }),
    unique("uniq_onboarding_task_dependencies_pair").on(
      table.organizationId,
      table.onboardingTaskId,
      table.prerequisiteTaskId,
    ),
    unique("uniq_onboarding_task_dependencies_order").on(
      table.organizationId,
      table.onboardingTaskId,
      table.sortOrder,
    ),
    index("idx_onboarding_task_dependencies_prerequisite").on(
      table.organizationId,
      table.prerequisiteTaskId,
    ),
    foreignKey({
      name: "fk_onboarding_task_dependencies_task",
      columns: [table.organizationId, table.onboardingTaskId],
      foreignColumns: [onboardingTasks.orgId, onboardingTasks.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_onboarding_task_dependencies_prerequisite",
      columns: [table.organizationId, table.prerequisiteTaskId],
      foreignColumns: [onboardingTasks.orgId, onboardingTasks.id],
    }).onDelete("restrict"),
    check(
      "chk_onboarding_task_dependencies_link",
      sql`${table.onboardingTaskId} <> ${table.prerequisiteTaskId} AND ${table.sortOrder} >= 0`,
    ),
  ],
);
