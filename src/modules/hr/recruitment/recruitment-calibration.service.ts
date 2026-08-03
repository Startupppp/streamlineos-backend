import {
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  calibrationParticipants,
  calibrationSessions,
  candidates,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type {
  CreateCalibrationInput,
  UpdateCalibrationInput,
} from "./dto/candidate-records.schemas";

@Injectable()
export class RecruitmentCalibrationService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listCalibration(orgId: string, candidateId: number) {
    return this.db.query.calibrationSessions
      .findMany({
        where: and(
          eq(calibrationSessions.candidateId, candidateId),
          eq(calibrationSessions.orgId, orgId),
        ),
        orderBy: (t, { desc: d }) => [d(t.createdAt)],
        with: { participants: { columns: { userId: true } } },
      })
      .then((sessions) =>
        sessions.map(({ participants, ...s }) => ({
          ...s,
          participantIds: participants.map((p) => p.userId),
        })),
      );
  }

  async createCalibration(
    orgId: string,
    userId: string,
    candidateId: number,
    input: CreateCalibrationInput,
  ) {
    await this.ensureCandidate(orgId, candidateId);

    const session = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(calibrationSessions)
        .values({
          orgId,
          candidateId,
          jobPostingId: input.jobPostingId,
          scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
          status: input.scheduledAt ? "scheduled" : "pending",
          notes: input.notes ?? null,
          createdBy: userId,
        })
        .returning();

      if (input.participantIds.length > 0) {
        await tx.insert(calibrationParticipants).values(
          input.participantIds.map((uid) => ({
            sessionId: created.id,
            orgId,
            userId: uid,
          })),
        );
      }

      return created;
    });

    return { ...session, participantIds: input.participantIds };
  }

  async updateCalibration(
    orgId: string,
    candidateId: number,
    input: UpdateCalibrationInput,
  ) {
    const updates: Partial<typeof calibrationSessions.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (input.scheduledAt !== undefined) {
      updates.scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : null;
    }
    if (input.status !== undefined) updates.status = input.status;
    if (input.notes !== undefined) updates.notes = input.notes;
    if (input.decision !== undefined) updates.decision = input.decision;

    const session = await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(calibrationSessions)
        .set(updates)
        .where(
          and(
            eq(calibrationSessions.id, input.id),
            eq(calibrationSessions.orgId, orgId),
            eq(calibrationSessions.candidateId, candidateId),
          ),
        )
        .returning();
      if (!updated) throw new NotFoundException("Session not found.");

      if (input.participantIds !== undefined) {
        await tx
          .delete(calibrationParticipants)
          .where(eq(calibrationParticipants.sessionId, input.id));
        if (input.participantIds.length > 0) {
          await tx.insert(calibrationParticipants).values(
            input.participantIds.map((uid) => ({
              sessionId: input.id,
              orgId,
              userId: uid,
            })),
          );
        }
      }

      return updated;
    });

    let participantIds: string[];
    if (input.participantIds !== undefined) {
      participantIds = input.participantIds;
    } else {
      const rows = await this.db
        .select({ userId: calibrationParticipants.userId })
        .from(calibrationParticipants)
        .where(eq(calibrationParticipants.sessionId, input.id));
      participantIds = rows.map((r) => r.userId);
    }

    return { ...session, participantIds };
  }

  private async ensureCandidate(orgId: string, candidateId: number): Promise<void> {
    const candidate = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
      columns: { id: true },
    });
    if (!candidate) throw new NotFoundException("Candidate not found.");
  }
}
