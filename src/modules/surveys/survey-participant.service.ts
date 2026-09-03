import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes, createHash } from "node:crypto";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { surveyParticipants } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { assertSurveyInOrg } from "./survey-tenant";
import type { ImportParticipantsInput, ListParticipantsInput } from "./dto/survey-participants.schemas";
import { buildListResponse, paginateOffset } from "../../common/pagination/pagination";

const PARTICIPANT_INSERT_CHUNK = 500;

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

@Injectable()
export class SurveyParticipantService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string, surveyId: number, filters: ListParticipantsInput) {
    await assertSurveyInOrg(this.db, orgId, surveyId);
    const conditions = [eq(surveyParticipants.orgId, orgId), eq(surveyParticipants.surveyId, surveyId)];
    if (filters.status) conditions.push(eq(surveyParticipants.status, filters.status));

    const where = and(...conditions);
    const { limit, offset } = paginateOffset(filters);

    const [rows, [totalRow]] = await Promise.all([
      this.db.query.surveyParticipants.findMany({
        where,
        orderBy: [desc(surveyParticipants.createdAt)],
        limit,
        offset,
      }),
      this.db.select({ total: count() }).from(surveyParticipants).where(where),
    ]);

    return buildListResponse(rows, Number(totalRow?.total ?? 0), filters);
  }

  /**
   * One multi-row INSERT per chunk instead of one per participant.
   *
   * The raw token is generated before the write and never leaves this method
   * except in the return value, so pairing it back to the inserted row means
   * keeping the two arrays aligned — `RETURNING` preserves the order of the
   * VALUES list, which is what makes the pairing sound.
   */
  async import(orgId: string, surveyId: number, input: ImportParticipantsInput) {
    const prepared = input.participants.map((participant) => {
      const rawToken = randomBytes(24).toString("hex");
      return {
        rawToken,
        values: {
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
          status: "invited" as const,
          accessTokenHash: hashToken(rawToken),
          metadata: participant.metadata ?? {},
          invitedAt: new Date(),
        },
      };
    });

    const created: Array<{ id: number; accessToken: string | null }> = [];
    for (let offset = 0; offset < prepared.length; offset += PARTICIPANT_INSERT_CHUNK) {
      const chunk = prepared.slice(offset, offset + PARTICIPANT_INSERT_CHUNK);
      const rows = await this.db
        .insert(surveyParticipants)
        .values(chunk.map((entry) => entry.values))
        .returning({ id: surveyParticipants.id });
      rows.forEach((row, index) => {
        const entry = chunk[index];
        if (entry) created.push({ id: row.id, accessToken: entry.rawToken });
      });
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
      columns: { status: true },
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
