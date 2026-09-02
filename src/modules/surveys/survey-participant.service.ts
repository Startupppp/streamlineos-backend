import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes, createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { surveyParticipants } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { ImportParticipantsInput, ListParticipantsInput } from "./dto/survey-participants.schemas";

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

@Injectable()
export class SurveyParticipantService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string, surveyId: number, filters: ListParticipantsInput) {
    const conditions = [eq(surveyParticipants.orgId, orgId), eq(surveyParticipants.surveyId, surveyId)];
    if (filters.status) conditions.push(eq(surveyParticipants.status, filters.status));

    return this.db.query.surveyParticipants.findMany({
      where: and(...conditions),
      orderBy: [desc(surveyParticipants.createdAt)],
      limit: filters.pageSize,
      offset: (filters.page - 1) * filters.pageSize,
    });
  }

  async import(orgId: string, surveyId: number, input: ImportParticipantsInput) {
    const created: Array<{ id: number; accessToken: string | null }> = [];
    for (const participant of input.participants) {
      const rawToken = randomBytes(24).toString("hex");
      const [row] = await this.db
        .insert(surveyParticipants)
        .values({
          orgId,
          surveyId,
          collectorId: input.collectorId ?? null,
          userId: participant.userId ?? null,
          contactId: participant.contactId ?? null,
          leadId: participant.leadId ?? null,
          clientId: participant.clientId ?? null,
          name: participant.name ?? null,
          email: participant.email ?? null,
          phone: participant.phone ?? null,
          status: "invited",
          accessTokenHash: hashToken(rawToken),
          metadata: participant.metadata ?? {},
          invitedAt: new Date(),
        })
        .returning();
      created.push({ id: row.id, accessToken: rawToken });
    }
    return created;
  }

  /**
   * Both bulk actions reported the *requested* count, so a mixed-tenant list
   * came back as a full success while only the caller's own participants moved.
   * The whole request fails unless every id is this survey's, and a miss is 404.
   */
  private async assertOwnsAll(orgId: string, surveyId: number, participantIds: number[]) {
    const requestedIds = [...new Set(participantIds)];
    const owned = await this.db
      .select({ id: surveyParticipants.id })
      .from(surveyParticipants)
      .where(and(eq(surveyParticipants.orgId, orgId), eq(surveyParticipants.surveyId, surveyId), inArray(surveyParticipants.id, requestedIds)))
      .limit(requestedIds.length);
    if (owned.length !== requestedIds.length)
      throw new NotFoundException("One or more participant IDs not found in this survey");
    return requestedIds;
  }

  async invite(orgId: string, surveyId: number, participantIds: number[]) {
    const requestedIds = await this.assertOwnsAll(orgId, surveyId, participantIds);
    await this.db
      .update(surveyParticipants)
      .set({ status: "invited", invitedAt: new Date() })
      .where(and(eq(surveyParticipants.orgId, orgId), eq(surveyParticipants.surveyId, surveyId), inArray(surveyParticipants.id, requestedIds)));
    return { success: true, count: requestedIds.length };
  }

  async remind(orgId: string, surveyId: number, participantIds: number[]) {
    const requestedIds = await this.assertOwnsAll(orgId, surveyId, participantIds);
    const rows = await this.db.query.surveyParticipants.findMany({
      where: and(eq(surveyParticipants.orgId, orgId), eq(surveyParticipants.surveyId, surveyId), inArray(surveyParticipants.id, requestedIds)),
      limit: requestedIds.length,
    });
    return { success: true, remindable: rows.filter((r) => r.status !== "completed").length };
  }

  async findByAccessToken(rawToken: string) {
    const hashed = hashToken(rawToken);
    const participant = await this.db.query.surveyParticipants.findFirst({
      where: eq(surveyParticipants.accessTokenHash, hashed),
    });
    if (!participant) throw new NotFoundException("Invalid access token");
    return participant;
  }

  async markStatus(participantId: number, status: (typeof surveyParticipants.$inferInsert)["status"], timestampField?: "openedAt" | "startedAt" | "completedAt") {
    const patch: Record<string, unknown> = { status };
    if (timestampField) patch[timestampField] = new Date();
    await this.db.update(surveyParticipants).set(patch).where(eq(surveyParticipants.id, participantId));
  }
}
