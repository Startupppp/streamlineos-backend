import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lt, notInArray, or, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.types";
import {
  organizationLifecycleSagas,
  organizationReservations,
  organizationSagaSteps,
  type OrganizationReservationKind,
  type OrganizationSagaKind,
} from "../../../../db/schema/common/organization-lifecycle";
import { isUniqueViolation } from "../../../../common/db/postgres-error";
import { SAGA_STEPS, TRANSITION_TABLE } from "./organization-lifecycle-transitions";

export type SagaWithSteps = {
  saga: typeof organizationLifecycleSagas.$inferSelect;
  steps: (typeof organizationSagaSteps.$inferSelect)[];
};

export class OrganizationSagaBusyError extends Error {}

const SAGA_EXECUTION_LEASE_MS = 15 * 60 * 1000;

@Injectable()
export class OrganizationSagaService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async claimExecution(sagaId: string): Promise<string | null> {
    const executionToken = randomUUID();
    const claimed = await this.db
      .update(organizationLifecycleSagas)
      .set({
        state: "RUNNING",
        lastError: executionToken,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(organizationLifecycleSagas.sagaId, sagaId),
          notInArray(organizationLifecycleSagas.state, [
            "COMPLETED",
            "COMPENSATED",
            "COMPENSATING",
          ]),
          or(
            notInArray(organizationLifecycleSagas.state, ["RUNNING"]),
            lt(
              organizationLifecycleSagas.updatedAt,
              sql`now() - make_interval(secs => ${SAGA_EXECUTION_LEASE_MS / 1000})`,
            ),
          ),
        ),
      )
      .returning({ sagaId: organizationLifecycleSagas.sagaId });
    return claimed.length === 1 ? executionToken : null;
  }

  async ownsExecution(sagaId: string, executionToken: string): Promise<boolean> {
    const [owner] = await this.db
      .select({ sagaId: organizationLifecycleSagas.sagaId })
      .from(organizationLifecycleSagas)
      .where(
        and(
          eq(organizationLifecycleSagas.sagaId, sagaId),
          inArray(organizationLifecycleSagas.state, ["RUNNING", "COMPENSATING"]),
          eq(organizationLifecycleSagas.lastError, executionToken),
        ),
      )
      .limit(1);
    return owner != null;
  }

  async markFailed(
    sagaId: string,
    error: unknown,
    executionToken?: string,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.db
      .update(organizationLifecycleSagas)
      .set({ state: "FAILED", lastError: message })
      .where(
        and(
          eq(organizationLifecycleSagas.sagaId, sagaId),
          notInArray(organizationLifecycleSagas.state, [
            "COMPLETED",
            "COMPENSATED",
          ]),
          ...(executionToken
            ? [eq(organizationLifecycleSagas.lastError, executionToken)]
            : []),
        ),
      );
  }

  async findByRequestKey(requestKey: string) {
    const [saga] = await this.db
      .select()
      .from(organizationLifecycleSagas)
      .where(eq(organizationLifecycleSagas.requestKey, requestKey))
      .limit(1);
    return saga ?? null;
  }

  async wasTerminallyDeleted(organizationId: string): Promise<boolean> {
    const [saga] = await this.db
      .select({ sagaId: organizationLifecycleSagas.sagaId })
      .from(organizationLifecycleSagas)
      .where(
        and(
          eq(organizationLifecycleSagas.organizationId, organizationId),
          eq(organizationLifecycleSagas.kind, "TERMINAL_DELETE"),
          eq(organizationLifecycleSagas.state, "COMPLETED"),
        ),
      )
      .limit(1);
    return saga != null;
  }

  async markCompensated(
    sagaId: string,
    executionToken: string,
  ): Promise<void> {
    const compensated = await this.db
      .update(organizationLifecycleSagas)
      .set({ state: "COMPENSATED", completedAt: new Date(), lastError: null })
      .where(
        and(
          eq(organizationLifecycleSagas.sagaId, sagaId),
          eq(organizationLifecycleSagas.state, "RUNNING"),
          eq(organizationLifecycleSagas.lastError, executionToken),
        ),
      )
      .returning({ sagaId: organizationLifecycleSagas.sagaId });
    if (compensated.length !== 1)
      throw new OrganizationSagaBusyError(
        `Organization saga ${sagaId} execution ownership was lost`,
      );
  }

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
      orgId: saga.organizationId,
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
      .orderBy(organizationSagaSteps.position)
      .limit(100);

    return { saga, steps };
  }

  async runStep<T>(
    sagaId: string,
    stepName: string,
    fn: () => Promise<T>,
    executionToken?: string,
  ): Promise<T> {
    if (executionToken)
      await this.renewExecution(sagaId, executionToken);
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

    const heartbeat = executionToken
      ? setInterval(() => {
          void this.renewExecution(sagaId, executionToken).catch(() => undefined);
        }, 30_000)
      : null;
    heartbeat?.unref();

    try {
      const result = await fn();
      if (executionToken)
        await this.renewExecution(sagaId, executionToken);
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
      if (executionToken) {
        if (!(await this.tryRenewExecution(sagaId, executionToken))) throw err;
      }
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
      if (!executionToken)
        await this.db
          .update(organizationLifecycleSagas)
          .set({ state: "FAILED", lastError: errorText })
          .where(eq(organizationLifecycleSagas.sagaId, sagaId));
      throw err;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }

  async complete(sagaId: string, executionToken?: string): Promise<void> {
    const completed = await this.db
      .update(organizationLifecycleSagas)
      .set({ state: "COMPLETED", completedAt: new Date(), lastError: null })
      .where(
        and(
          eq(organizationLifecycleSagas.sagaId, sagaId),
          notInArray(organizationLifecycleSagas.state, ["COMPLETED", "COMPENSATED"]),
          ...(executionToken
            ? [eq(organizationLifecycleSagas.lastError, executionToken)]
            : []),
        ),
      )
      .returning({ sagaId: organizationLifecycleSagas.sagaId });
    if (executionToken && completed.length !== 1)
      throw new OrganizationSagaBusyError(
        `Organization saga ${sagaId} execution ownership was lost`,
      );
  }

  async compensate(
    sagaId: string,
    compensators: Record<string, () => Promise<void>>,
    executionToken?: string,
  ): Promise<void> {
    const started = await this.db
      .update(organizationLifecycleSagas)
      .set({ state: "COMPENSATING" })
      .where(
        and(
          eq(organizationLifecycleSagas.sagaId, sagaId),
          notInArray(organizationLifecycleSagas.state, [
            "COMPLETED",
            "COMPENSATED",
          ]),
          ...(executionToken
            ? [eq(organizationLifecycleSagas.lastError, executionToken)]
            : []),
        ),
      )
      .returning({ sagaId: organizationLifecycleSagas.sagaId });
    if (executionToken && started.length !== 1)
      throw new OrganizationSagaBusyError(
        `Organization saga ${sagaId} execution ownership was lost`,
      );

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
      .orderBy(desc(organizationSagaSteps.position))
      .limit(100);

    for (const step of doneSteps) {
      if (executionToken)
        await this.renewExecution(sagaId, executionToken);
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
      .set({ state: "COMPENSATED", completedAt: new Date(), lastError: null })
      .where(
        and(
          eq(organizationLifecycleSagas.sagaId, sagaId),
          ...(executionToken
            ? [eq(organizationLifecycleSagas.lastError, executionToken)]
            : []),
        ),
      );
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
      if (isUniqueViolation(err)) {
        const [existing] = await this.db
          .select({
            organizationId: organizationReservations.organizationId,
            sagaId: organizationReservations.sagaId,
            state: organizationReservations.state,
          })
          .from(organizationReservations)
          .where(
            and(
              eq(organizationReservations.kind, kind),
              eq(organizationReservations.value, value),
            ),
          )
          .limit(1);
        return (
          existing?.organizationId === organizationId &&
          existing.sagaId === sagaId &&
          (existing.state === "RESERVED" || existing.state === "CLAIMED")
        );
      }
      throw err;
    }
  }

  async findReservationValue(
    kind: OrganizationReservationKind,
    sagaId: string,
  ): Promise<string | null> {
    const [reservation] = await this.db
      .select({ value: organizationReservations.value })
      .from(organizationReservations)
      .where(
        and(
          eq(organizationReservations.kind, kind),
          eq(organizationReservations.sagaId, sagaId),
          inArray(organizationReservations.state, ["RESERVED", "CLAIMED"]),
        ),
      )
      .limit(1);
    return reservation?.value ?? null;
  }

  async claim(
    kind: OrganizationReservationKind,
    value: string,
    sagaId?: string,
  ): Promise<void> {
    await this.db
      .update(organizationReservations)
      .set({ state: "CLAIMED", claimedAt: new Date() })
      .where(
        and(
          eq(organizationReservations.kind, kind),
          eq(organizationReservations.value, value),
          eq(organizationReservations.state, "RESERVED"),
          ...(sagaId ? [eq(organizationReservations.sagaId, sagaId)] : []),
        ),
      );
  }

  async release(
    kind: OrganizationReservationKind,
    value: string,
    sagaId?: string,
  ): Promise<void> {
    await this.db
      .delete(organizationReservations)
      .where(
        and(
          eq(organizationReservations.kind, kind),
          eq(organizationReservations.value, value),
          ...(sagaId ? [eq(organizationReservations.sagaId, sagaId)] : []),
        ),
      );
  }

  private async tryRenewExecution(
    sagaId: string,
    executionToken: string,
  ): Promise<boolean> {
    const renewed = await this.db
      .update(organizationLifecycleSagas)
      .set({ updatedAt: sql`now()` })
      .where(
        and(
          eq(organizationLifecycleSagas.sagaId, sagaId),
          inArray(organizationLifecycleSagas.state, ["RUNNING", "COMPENSATING"]),
          eq(organizationLifecycleSagas.lastError, executionToken),
        ),
      )
      .returning({ sagaId: organizationLifecycleSagas.sagaId });
    return renewed.length === 1;
  }

  private async renewExecution(
    sagaId: string,
    executionToken: string,
  ): Promise<void> {
    if (!(await this.tryRenewExecution(sagaId, executionToken)))
      throw new OrganizationSagaBusyError(
        `Organization saga ${sagaId} execution ownership was lost`,
      );
  }
}
