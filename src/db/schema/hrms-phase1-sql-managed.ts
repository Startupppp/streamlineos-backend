/**
 * DO NOT DELETE, AND DO NOT ADD TO `db/schema/index.ts`.
 *
 * These tables are managed by raw SQL migrations, so they are deliberately kept
 * out of the runtime barrel — Drizzle must never generate DDL for them. Being
 * unimported IS the design, which means knip reports all 11 as unused and a
 * dead-code sweep will propose deleting them. `migration-integrity.spec.ts`
 * asserts this arrangement ("keeps SQL-managed objects outside the Drizzle
 * schema and journal"); removing a file here fails that spec.
 */
export * from "./common/org-unit-closure";
export * from "./directory/hrms-migration-profile";
export * from "./directory/worker-engagement-state-events";
export * from "./directory/workforce-periods";
export * from "./hr/attendance-correction-links";
export * from "./hr/attendance-event-evidence";
export * from "./hr/attendance-event-store";
export * from "./hr/attendance-projections";
export * from "./hr/audit-events";
export * from "./hr/worker-leave-balance-projections";
export * from "./hr/worker-leave-ledger";
export * from "./hr/workforce-legacy-maps";
export * from "./hr/workforce-reconciliation";
