import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const ORGANIZATION_SAGA_KINDS = [
  "CREATE",
  "ARCHIVE",
  "RESTORE",
  "EXPORT",
  "OWNERSHIP_TRANSFER",
  "PURGE_SCHEDULE",
  "PURGE_CANCEL",
  "LEGAL_HOLD",
  "LEGAL_HOLD_RELEASE",
  "TERMINAL_DELETE",
] as const;

export type OrganizationSagaKind = (typeof ORGANIZATION_SAGA_KINDS)[number];

export const ORGANIZATION_SAGA_STATES = [
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "COMPENSATING",
  "COMPENSATED",
  "FAILED",
] as const;

export type OrganizationSagaState = (typeof ORGANIZATION_SAGA_STATES)[number];

export const ORGANIZATION_SAGA_STEP_STATES = [
  "PENDING",
  "RUNNING",
  "DONE",
  "FAILED",
  "COMPENSATED",
] as const;

export type OrganizationSagaStepState =
  (typeof ORGANIZATION_SAGA_STEP_STATES)[number];

export const ORGANIZATION_RESERVATION_KINDS = [
  "ORGANIZATION_ID",
  "SLUG",
  "DOMAIN",
] as const;

export type OrganizationReservationKind =
  (typeof ORGANIZATION_RESERVATION_KINDS)[number];

export const ORGANIZATION_RESERVATION_STATES = [
  "RESERVED",
  "CLAIMED",
  "RELEASED",
] as const;

export type OrganizationReservationState =
  (typeof ORGANIZATION_RESERVATION_STATES)[number];

export const organizationSagaKindEnum = pgEnum(
  "organization_saga_kind",
  ORGANIZATION_SAGA_KINDS,
);
export const organizationSagaStateEnum = pgEnum(
  "organization_saga_state",
  ORGANIZATION_SAGA_STATES,
);
export const organizationSagaStepStateEnum = pgEnum(
  "organization_saga_step_state",
  ORGANIZATION_SAGA_STEP_STATES,
);
export const organizationReservationKindEnum = pgEnum(
  "organization_reservation_kind",
  ORGANIZATION_RESERVATION_KINDS,
);
export const organizationReservationStateEnum = pgEnum(
  "organization_reservation_state",
  ORGANIZATION_RESERVATION_STATES,
);

export const organizationLifecycleSagas = pgTable(
  "organization_lifecycle_sagas",
  {
    sagaId: uuid("saga_id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull(),
    kind: organizationSagaKindEnum("kind").notNull(),
    state: organizationSagaStateEnum("state").default("PENDING").notNull(),
    requestKey: text("request_key").notNull(),
    actorUserId: text("actor_user_id"),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    lastError: text("last_error"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("uniq_org_lifecycle_sagas_request").on(table.requestKey),
    index("idx_org_lifecycle_sagas_org").on(table.organizationId, table.kind),
    index("idx_org_lifecycle_sagas_state").on(table.state, table.startedAt),
  ],
);

export const organizationSagaSteps = pgTable(
  "organization_saga_steps",
  {
    stepId: uuid("step_id").defaultRandom().primaryKey(),
    sagaId: uuid("saga_id")
      .references(() => organizationLifecycleSagas.sagaId, {
        onDelete: "cascade",
      })
      .notNull(),
    stepName: text("step_name").notNull(),
    position: integer("position").notNull(),
    state: organizationSagaStepStateEnum("state").default("PENDING").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    detail: text("detail"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_org_saga_steps_saga_step").on(table.sagaId, table.stepName),
    index("idx_org_saga_steps_saga").on(table.sagaId, table.position),
  ],
);

export const organizationReservations = pgTable(
  "organization_reservations",
  {
    reservationId: uuid("reservation_id").defaultRandom().primaryKey(),
    kind: organizationReservationKindEnum("kind").notNull(),
    value: text("value").notNull(),
    organizationId: text("organization_id").notNull(),
    sagaId: uuid("saga_id").references(() => organizationLifecycleSagas.sagaId, {
      onDelete: "cascade",
    }),
    state: organizationReservationStateEnum("state")
      .default("RESERVED")
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("uniq_org_reservations_kind_value").on(table.kind, table.value),
    index("idx_org_reservations_org").on(table.organizationId),
    index("idx_org_reservations_expiry").on(table.state, table.expiresAt),
  ],
);
