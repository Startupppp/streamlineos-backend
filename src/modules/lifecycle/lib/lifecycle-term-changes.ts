import { NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.types";
import {
  customerLifecycleSignals,
  customerLifecycles,
  type CustomerLifecycleStatus,
} from "../../../db/schema/crm/lifecycle";
import { impactFor, riskBand } from "../lifecycle-risk";
import { renewalDate } from "../lifecycle-terms";
import type {
  CloseLifecycleInput,
  RecordSignalInput,
  RenewLifecycleInput,
} from "../dto/lifecycle.schemas";
import { rescore } from "./lifecycle-scoring";

/*
  Keeping the book honest: the writes behind `LifecycleService.recordSignal`,
  `renew` and `close`, whose docblocks state the rules. The service loads the
  contract first (the 404 for another tenant's id) and hands its handle in.
*/

type LifecycleRow = typeof customerLifecycles.$inferSelect;

export async function recordLifecycleSignal(
  handle: Db,
  organizationId: string,
  customerLifecycleId: string,
  input: RecordSignalInput,
  userId: string | null,
) {
  return handle.transaction(async (tx) => {
    const db = tx as Db;

    const [signal] = await db
      .insert(customerLifecycleSignals)
      .values({
        organizationId,
        customerLifecycleId,
        kind: input.kind,
        impact: impactFor(input.kind, input.impact),
        observedAt: input.observedAt ?? new Date(),
        source: userId ? "human" : "system",
        recordedByUserId: userId,
        note: input.note ?? null,
      })
      .returning();

    const rescored = await rescore(db, organizationId, customerLifecycleId);
    return { data: { signal, riskScore: rescored.riskScore, band: riskBand(rescored.riskScore) } };
  });
}

export async function renewLifecycle(
  handle: Db,
  lifecycle: LifecycleRow,
  organizationId: string,
  customerLifecycleId: string,
  input: RenewLifecycleInput,
  userId: string | null,
) {
  if (lifecycle.status !== "active") {
    throw new NotFoundException("Only an active contract can be renewed");
  }

  const startedOn = input.startedOn ?? lifecycle.renewalOn;
  const termMonths = input.termMonths ?? lifecycle.termMonths;
  const nextRenewal = renewalDate(startedOn, termMonths);

  /**
   * Both halves are already bounded by the schema, so this is unreachable in
   * practice. It is a 404 rather than a 500 because the alternative is writing
   * `null` into a NOT NULL column and losing the contract's renewal date.
   */
  if (!nextRenewal) throw new NotFoundException("Unusable renewal term");

  return handle.transaction(async (tx) => {
    const db = tx as Db;

    const [updated] = await db
      .update(customerLifecycles)
      .set({
        startedOn,
        termMonths,
        renewalOn: nextRenewal,
        contractValueMinor: input.contractValueMinor ?? lifecycle.contractValueMinor,
        renewalCount: lifecycle.renewalCount + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(customerLifecycles.organizationId, organizationId),
          eq(customerLifecycles.customerLifecycleId, customerLifecycleId),
          /**
           * The status is re-asserted in the WHERE rather than trusted from
           * the read above. Two people confirming the same renewal at once
           * would otherwise both advance the term and the contract would jump
           * two years forward for one signature.
           */
          eq(customerLifecycles.status, "active"),
          eq(customerLifecycles.renewalCount, lifecycle.renewalCount),
        ),
      )
      .returning();

    if (!updated) throw new NotFoundException("Contract changed while renewing");

    await db.insert(customerLifecycleSignals).values({
      organizationId,
      customerLifecycleId,
      kind: "renewal-commitment",
      impact: impactFor("renewal-commitment", null),
      observedAt: new Date(),
      source: userId ? "human" : "system",
      recordedByUserId: userId,
      note: input.note ?? null,
    });

    const rescored = await rescore(db, organizationId, customerLifecycleId);
    return { data: { ...updated, riskScore: rescored.riskScore, band: riskBand(rescored.riskScore) } };
  });
}

export async function closeLifecycle(
  handle: Db,
  organizationId: string,
  customerLifecycleId: string,
  input: CloseLifecycleInput,
) {
  const [updated] = await handle
    .update(customerLifecycles)
    .set({
      status: input.status as CustomerLifecycleStatus,
      closedReason: input.reason,
      closedAt: new Date(),
      /**
       * Zeroed on close. The score answers "is this revenue at risk", and
       * revenue that has already gone is not at risk — leaving the last live
       * score behind would keep churned customers permanently at the top of
       * the triage list.
       */
      riskScore: 0,
      riskComputedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(customerLifecycles.organizationId, organizationId),
        eq(customerLifecycles.customerLifecycleId, customerLifecycleId),
        eq(customerLifecycles.status, "active"),
      ),
    )
    .returning();

  if (!updated) throw new NotFoundException("Only an active contract can be closed");

  return { data: updated };
}
