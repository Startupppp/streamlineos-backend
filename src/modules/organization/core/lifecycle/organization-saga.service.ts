import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.types";
import {
  organizationLifecycleSagas,
  organizationReservations,
  organizationSagaSteps,
  type OrganizationReservationKind,
  type OrganizationSagaKind,
} from "../../../../db/schema/common/organization-lifecycle";
import { sqlstateOf } from "../../../../common/observability/error-classification";
import { SAGA_STEPS, TRANSITION_TABLE } from "./organization-lifecycle-transitions";

/**
 * Drizzle wraps the driver error, so the SQLSTATE is a cause link down and
 * `err.code` is undefined — a direct read reports every taken slug as a 500.
 * `sqlstateOf` walks the chain by shape, which also survives postgres-js
 * building that inner error in another realm.
 */
function isUniqueViolation(err: unknown): boolean {
  return sqlstateOf(err) === "23505";
}

export type SagaWithSteps = {
  saga: typeof organizationLifecycleSagas.$inferSelect;
  steps: (typeof organizationSagaSteps.$inferSelect)[];
};

@Injectable()
export class OrganizationSagaService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async begin(
    kind: OrganizationSagaKind,
    organizationId: string,
    requestKey: string,
    actorUserId: string | null,
    fromStatus: string | null,
  ): Promise<SagaWithSteps> {
    await this.db
      .insert(organizationLifecycleSagas)
      .values({
        organizationId,
        kind,
        state: "PENDING",
        requestKey,
        actorUserId,
        fromStatus,
        toStatus: TRANSITION_TABLE[kind].resultingStatus,
      })
      .onConflictDoNothing({ target: organizationLifecycleSagas.requestKey });

    const [saga] = await this.db
      .select()
      .from(organizationLifecycleSagas)
      .where(eq(organizationLifecycleSagas.requestKey, requestKey))
      .limit(1);

    if (!saga) throw new Error(`Saga not found for requestKey ${requestKey}`);

    const stepDefs = SAGA_STEPS[kind];
    const stepValues = stepDefs.map((stepName, idx) => ({
      sagaId: saga.sagaId,
      stepName,
      position: idx,
      state: "PENDING" as const,
      attempts: 0,
    }));

    await this.db
      .insert(organizationSagaSteps)
      .values(stepValues)
      .onConflictDoNothing();

    const steps = await this.db
      .select()
      .from(organizationSagaSteps)
      .where(eq(organizationSagaSteps.sagaId, saga.sagaId))
      .orderBy(organizationSagaSteps.position);

    return { saga, steps };
  }

  async runStep<T>(
    sagaId: string,
    stepName: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    await this.db
      .update(organizationSagaSteps)
      .set({
        state: "RUNNING",
        startedAt: new Date(),
        attempts: sql`${organizationSagaSteps.attempts} + 1`,
      })
      .where(
        and(
          eq(organizationSagaSteps.sagaId, sagaId),
          eq(organizationSagaSteps.stepName, stepName),
        ),
      );

    try {
      const result = await fn();
      await this.db
        .update(organizationSagaSteps)
        .set({ state: "DONE", completedAt: new Date() })
        .where(
          and(
            eq(organizationSagaSteps.sagaId, sagaId),
            eq(organizationSagaSteps.stepName, stepName),
          ),
        );
      return result;
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err);
      await this.db
        .update(organizationSagaSteps)
        .set({ state: "FAILED", detail: errorText, completedAt: new Date() })
        .where(
          and(
            eq(organizationSagaSteps.sagaId, sagaId),
            eq(organizationSagaSteps.stepName, stepName),
          ),
        );
      await this.db
        .update(organizationLifecycleSagas)
        .set({ state: "FAILED", lastError: errorText })
        .where(eq(organizationLifecycleSagas.sagaId, sagaId));
      throw err;
    }
  }

  async complete(sagaId: string): Promise<void> {
    await this.db
      .update(organizationLifecycleSagas)
      .set({ state: "COMPLETED", completedAt: new Date() })
      .where(eq(organizationLifecycleSagas.sagaId, sagaId));
  }

  async fail(sagaId: string, error: string): Promise<void> {
    await this.db
      .update(organizationLifecycleSagas)
      .set({ state: "FAILED", lastError: error })
      .where(eq(organizationLifecycleSagas.sagaId, sagaId));
  }

  async compensate(
    sagaId: string,
    compensators: Record<string, () => Promise<void>>,
  ): Promise<void> {
    await this.db
      .update(organizationLifecycleSagas)
      .set({ state: "COMPENSATING" })
      .where(eq(organizationLifecycleSagas.sagaId, sagaId));

    const doneSteps = await this.db
      .select({
        stepName: organizationSagaSteps.stepName,
        position: organizationSagaSteps.position,
      })
      .from(organizationSagaSteps)
      .where(
        and(
          eq(organizationSagaSteps.sagaId, sagaId),
          eq(organizationSagaSteps.state, "DONE"),
        ),
      )
      .orderBy(desc(organizationSagaSteps.position));

    for (const step of doneSteps) {
      const compensator = compensators[step.stepName];
      if (compensator) await compensator();
      await this.db
        .update(organizationSagaSteps)
        .set({ state: "COMPENSATED" })
        .where(
          and(
            eq(organizationSagaSteps.sagaId, sagaId),
            eq(organizationSagaSteps.stepName, step.stepName),
          ),
        );
    }

    await this.db
      .update(organizationLifecycleSagas)
      .set({ state: "COMPENSATED", completedAt: new Date() })
      .where(eq(organizationLifecycleSagas.sagaId, sagaId));
  }

  async reserve(
    kind: OrganizationReservationKind,
    value: string,
    organizationId: string,
    sagaId: string,
  ): Promise<boolean> {
    try {
      await this.db.insert(organizationReservations).values({
        kind,
        value,
        organizationId,
        sagaId,
        state: "RESERVED",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });
      return true;
    } catch (err: unknown) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }

  async claim(kind: OrganizationReservationKind, value: string): Promise<void> {
    await this.db
      .update(organizationReservations)
      .set({ state: "CLAIMED", claimedAt: new Date() })
      .where(
        and(
          eq(organizationReservations.kind, kind),
          eq(organizationReservations.value, value),
          eq(organizationReservations.state, "RESERVED"),
        ),
      );
  }

  async release(kind: OrganizationReservationKind, value: string): Promise<void> {
    await this.db
      .delete(organizationReservations)
      .where(
        and(
          eq(organizationReservations.kind, kind),
          eq(organizationReservations.value, value),
        ),
      );
  }
}
