import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { tasks, taskSequences, taskSequenceSteps } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type { SequenceApplyInput, SequenceCreateInput, SequenceListInput } from "./dto/task.schemas";
import { addDays } from "./task-date-utils";

@Injectable()
export class TaskSequencesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listSequences(orgId: string, input: SequenceListInput) {
    return this.db.query.taskSequences.findMany({
      where: eq(taskSequences.orgId, orgId),
      with: { steps: { orderBy: (s, { asc }) => [asc(s.order)] } },
      orderBy: (t, { desc }) => [desc(t.createdAt)],
      limit: input.limit,
    });
  }

  async createSequence(orgId: string, userId: string, input: SequenceCreateInput) {
    return this.db.transaction(async (tx) => {
      const [seq] = await tx
        .insert(taskSequences)
        .values({
          orgId,
          name: input.name,
          description: input.description,
          createdBy: userId,
        })
        .returning();

      if (input.steps.length > 0) {
        await tx.insert(taskSequenceSteps).values(
          input.steps.map((step, i) => ({
            sequenceId: seq.id,
            title: step.title,
            type: step.type,
            notes: step.notes,
            offsetDays: step.offsetDays,
            order: step.order ?? i,
          })),
        );
      }

      return tx.query.taskSequences.findFirst({
        where: eq(taskSequences.id, seq.id),
        with: { steps: { orderBy: (s, { asc }) => [asc(s.order)] } },
      });
    });
  }

  async removeSequence(orgId: string, sequenceId: number) {
    const [deleted] = await this.db
      .delete(taskSequences)
      .where(and(eq(taskSequences.id, sequenceId), eq(taskSequences.orgId, orgId)))
      .returning();

    if (!deleted) return null;
    return { success: true };
  }

  async applySequence(orgId: string, userId: string, sequenceId: number, input: SequenceApplyInput) {
    const seq = await this.db.query.taskSequences.findFirst({
      where: and(eq(taskSequences.id, sequenceId), eq(taskSequences.orgId, orgId)),
      with: { steps: { orderBy: (s, { asc }) => [asc(s.order)] } },
    });

    if (!seq) return { error: "not_found" as const };
    if (seq.steps.length === 0) return { error: "no_steps" as const };

    const base = new Date(input.baseDate);

    const created = await this.db
      .insert(tasks)
      .values(
        seq.steps.map((step) => ({
          orgId,
          title: step.title,
          notes: step.notes ?? null,
          type: (step.type as "CALL" | "EMAIL" | "MEETING" | "CUSTOM") ?? "CUSTOM",
          status: "pending" as const,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          assigneeId: input.assigneeId ?? null,
          createdBy: userId,
          dueDate: addDays(base, step.offsetDays),
        })),
      )
      .returning();

    return { created, count: created.length };
  }
}

export type ApplySequenceResult = Awaited<ReturnType<TaskSequencesService["applySequence"]>>;

export function isSequenceNotFound(
  result: ApplySequenceResult,
): result is { error: "not_found" } {
  return "error" in result && result.error === "not_found";
}

export function isSequenceNoSteps(
  result: ApplySequenceResult,
): result is { error: "no_steps" } {
  return "error" in result && result.error === "no_steps";
}
