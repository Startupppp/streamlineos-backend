import { ConflictException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { resignations, terminations } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";

type LifecycleTransitionWriter = Pick<Db, "update">;

interface ResignationTransitionInput {
  organizationId: string;
  resignationId: number;
  currentStatus: typeof resignations.$inferSelect.status;
  currentVersion: number;
  changes: Partial<typeof resignations.$inferInsert>;
}

interface TerminationTransitionInput {
  organizationId: string;
  terminationId: number;
  currentStatus: typeof terminations.$inferSelect.status;
  currentVersion: number;
  changes: Partial<typeof terminations.$inferInsert>;
}

export async function transitionResignation(
  writer: LifecycleTransitionWriter,
  input: ResignationTransitionInput,
): Promise<number> {
  const [updatedResignation] = await writer
    .update(resignations)
    .set({
      ...input.changes,
      rowVersion: sql<number>`${resignations.rowVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(resignations.orgId, input.organizationId),
        eq(resignations.id, input.resignationId),
        eq(resignations.status, input.currentStatus),
        eq(resignations.rowVersion, input.currentVersion),
      ),
    )
    .returning({ rowVersion: resignations.rowVersion });

  if (!updatedResignation) {
    throw new ConflictException(
      "The resignation changed while this request was being processed. Refresh and try again.",
    );
  }
  return updatedResignation.rowVersion;
}

export async function transitionTermination(
  writer: LifecycleTransitionWriter,
  input: TerminationTransitionInput,
): Promise<number> {
  const [updatedTermination] = await writer
    .update(terminations)
    .set({
      ...input.changes,
      rowVersion: sql<number>`${terminations.rowVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(terminations.orgId, input.organizationId),
        eq(terminations.id, input.terminationId),
        eq(terminations.status, input.currentStatus),
        eq(terminations.rowVersion, input.currentVersion),
      ),
    )
    .returning({ rowVersion: terminations.rowVersion });

  if (!updatedTermination) {
    throw new ConflictException(
      "The termination changed while this request was being processed. Refresh and try again.",
    );
  }
  return updatedTermination.rowVersion;
}
