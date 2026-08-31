import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { crmSequences, crmSequenceSteps, crmSequenceEnrollments } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetAfter } from "../../../common/pagination/keyset";
import type {
  CreateSequenceInput,
  UpdateSequenceInput,
  CreateSequenceStepInput,
  EnrollInSequenceInput,
} from "./dto/automation-studio.schemas";

@Injectable()
export class CrmSequencesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string) {
    const sequences = await this.db
      .select()
      .from(crmSequences)
      .where(and(eq(crmSequences.orgId, orgId), isNull(crmSequences.deletedAt)))
      .orderBy(desc(crmSequences.createdAt))
      .limit(100);
    return { sequences };
  }

  async create(orgId: string, input: CreateSequenceInput) {
    try {
      const [sequence] = await this.db
        .insert(crmSequences)
        .values({ orgId, ...input })
        .returning();
      return { sequence };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "23505") throw new ConflictException("A sequence with this name already exists");
      throw err;
    }
  }

  async getOne(orgId: string, sequenceId: string) {
    const [sequence] = await this.db
      .select()
      .from(crmSequences)
      .where(and(eq(crmSequences.id, sequenceId), eq(crmSequences.orgId, orgId), isNull(crmSequences.deletedAt)))
      .limit(1);
    return sequence ? { sequence } : null;
  }

  async update(orgId: string, sequenceId: string, input: UpdateSequenceInput) {
    try {
      const [sequence] = await this.db
        .update(crmSequences)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(crmSequences.id, sequenceId), eq(crmSequences.orgId, orgId), isNull(crmSequences.deletedAt)))
        .returning();
      return sequence ? { sequence } : null;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "23505") throw new ConflictException("A sequence with this name already exists");
      throw err;
    }
  }

  async remove(orgId: string, sequenceId: string) {
    const [deleted] = await this.db
      .update(crmSequences)
      .set({ deletedAt: new Date() })
      .where(and(eq(crmSequences.id, sequenceId), eq(crmSequences.orgId, orgId), isNull(crmSequences.deletedAt)))
      .returning({ id: crmSequences.id });
    if (!deleted) throw new NotFoundException("Sequence not found");
    return { success: true as const };
  }

  async listSteps(orgId: string, sequenceId: string) {
    await this.assertOwns(orgId, sequenceId);
    const steps = await this.db
      .select()
      .from(crmSequenceSteps)
      .where(eq(crmSequenceSteps.sequenceId, sequenceId))
      .orderBy(asc(crmSequenceSteps.sortOrder))
      .limit(200);
    return { steps };
  }

  async createStep(orgId: string, sequenceId: string, input: CreateSequenceStepInput) {
    await this.assertOwns(orgId, sequenceId);
    const [step] = await this.db
      .insert(crmSequenceSteps)
      .values({ sequenceId, ...input })
      .returning();
    return { step };
  }

  async removeStep(orgId: string, sequenceId: string, stepId: string) {
    await this.assertOwns(orgId, sequenceId);
    const [deleted] = await this.db
      .delete(crmSequenceSteps)
      .where(and(eq(crmSequenceSteps.id, stepId), eq(crmSequenceSteps.sequenceId, sequenceId)))
      .returning({ id: crmSequenceSteps.id });
    if (!deleted) throw new NotFoundException("Step not found");
    return { success: true as const };
  }

  async reorderSteps(orgId: string, sequenceId: string, order: string[]) {
    await this.assertOwns(orgId, sequenceId);
    await this.db.transaction(async (tx) => {
      for (let i = 0; i < order.length; i++) {
        const stepId = order[i];
        if (stepId) {
          await tx
            .update(crmSequenceSteps)
            .set({ sortOrder: i })
            .where(and(eq(crmSequenceSteps.id, stepId), eq(crmSequenceSteps.sequenceId, sequenceId)));
        }
      }
    });
    return { success: true as const };
  }

  async listEnrollments(orgId: string, sequenceId: string, cursor?: string) {
    await this.assertOwns(orgId, sequenceId);
    const limit = 20;
    const position = decodeCursor(cursor);
    const baseConditions = [
      eq(crmSequenceEnrollments.orgId, orgId),
      eq(crmSequenceEnrollments.sequenceId, sequenceId),
    ];
    const where = position
      ? and(...baseConditions, keysetAfter(crmSequenceEnrollments.createdAt, crmSequenceEnrollments.id, position))
      : and(...baseConditions);
    const rows = await this.db
      .select()
      .from(crmSequenceEnrollments)
      .where(where)
      .orderBy(asc(crmSequenceEnrollments.createdAt), asc(crmSequenceEnrollments.id))
      .limit(limit + 1);
    const page = buildCursorPage(rows, limit, (r) => ({ sortValue: r.createdAt.toISOString(), id: r.id }));
    return { enrollments: page.data, hasMore: page.pagination.hasMore, nextCursor: page.pagination.nextCursor };
  }

  async enroll(orgId: string, sequenceId: string, input: EnrollInSequenceInput) {
    await this.assertOwns(orgId, sequenceId);
    try {
      const [enrollment] = await this.db
        .insert(crmSequenceEnrollments)
        .values({ orgId, sequenceId, entityType: input.entityType, entityId: input.entityId, nextRunAt: new Date() })
        .onConflictDoNothing()
        .returning();
      if (!enrollment) throw new ConflictException("Entity is already enrolled in this sequence");
      return { enrollment };
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      throw err;
    }
  }

  async stopEnrollment(orgId: string, sequenceId: string, enrollmentId: string) {
    await this.assertOwns(orgId, sequenceId);
    const [updated] = await this.db
      .update(crmSequenceEnrollments)
      .set({ status: "stopped", stopReason: "manual_stop", updatedAt: new Date() })
      .where(
        and(
          eq(crmSequenceEnrollments.id, enrollmentId),
          eq(crmSequenceEnrollments.orgId, orgId),
          eq(crmSequenceEnrollments.sequenceId, sequenceId),
        ),
      )
      .returning({ id: crmSequenceEnrollments.id });
    if (!updated) throw new NotFoundException("Enrollment not found");
    return { success: true as const };
  }

  private async assertOwns(orgId: string, sequenceId: string): Promise<void> {
    const [row] = await this.db
      .select({ id: crmSequences.id })
      .from(crmSequences)
      .where(and(eq(crmSequences.id, sequenceId), eq(crmSequences.orgId, orgId), isNull(crmSequences.deletedAt)))
      .limit(1);
    if (!row) throw new NotFoundException("Sequence not found");
  }
}
