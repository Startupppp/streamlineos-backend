import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { csatResponses, csatSurveys } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type {
  CreateInput,
  PatchInput,
  SubmitResponseInput,
} from "./dto/csat.schemas";

const DEFAULT_QUESTION = "How satisfied are you with our service?";

@Injectable()
export class CsatService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listSurveys(orgId: string) {
    const surveys = await this.db.query.csatSurveys.findMany({
      where: eq(csatSurveys.orgId, orgId),
      with: {
        client: { columns: { id: true, name: true } },
        responses: { columns: { rating: true } },
      },
      orderBy: [desc(csatSurveys.createdAt)],
    });

    return surveys.map((s) => {
      const { responses, ...rest } = s;
      const responseCount = responses.length;
      const avgRating =
        responseCount > 0
          ? responses.reduce((sum, r) => sum + r.rating, 0) / responseCount
          : null;
      return { ...rest, responseCount, avgRating };
    });
  }

  async createSurvey(orgId: string, userId: string, input: CreateInput) {
    const [survey] = await this.db
      .insert(csatSurveys)
      .values({
        orgId,
        clientId: input.clientId ?? null,
        title: input.title,
        question: input.question ?? DEFAULT_QUESTION,
        scaleMax: input.scaleMax,
        status: "draft",
        publicToken: randomUUID(),
        createdBy: userId,
      })
      .returning();

    return survey;
  }

  getSurvey(orgId: string, surveyId: number) {
    return this.db.query.csatSurveys.findFirst({
      where: and(eq(csatSurveys.id, surveyId), eq(csatSurveys.orgId, orgId)),
      with: {
        client: { columns: { id: true, name: true } },
        responses: true,
      },
    });
  }

  async updateSurvey(orgId: string, surveyId: number, input: PatchInput) {
    const existing = await this.db.query.csatSurveys.findFirst({
      where: and(eq(csatSurveys.id, surveyId), eq(csatSurveys.orgId, orgId)),
      columns: { id: true },
    });
    if (!existing) return null;

    const updateValues: Record<string, unknown> = { updatedAt: new Date() };
    if (input.title !== undefined) updateValues.title = input.title;
    if (input.question !== undefined) updateValues.question = input.question;
    if (input.status === "sent") {
      updateValues.status = "sent";
      updateValues.sentAt = new Date();
    } else if (input.status === "closed") {
      updateValues.status = "closed";
      updateValues.closedAt = new Date();
    }

    const [updated] = await this.db
      .update(csatSurveys)
      .set(updateValues)
      .where(eq(csatSurveys.id, surveyId))
      .returning();

    return updated;
  }

  async deleteSurvey(orgId: string, surveyId: number) {
    const existing = await this.db.query.csatSurveys.findFirst({
      where: and(eq(csatSurveys.id, surveyId), eq(csatSurveys.orgId, orgId)),
      columns: { id: true },
    });
    if (!existing) return null;

    await this.db.delete(csatSurveys).where(and(eq(csatSurveys.id, surveyId), eq(csatSurveys.orgId, orgId)));

    return { success: true };
  }

  async listResponses(orgId: string, surveyId: number, limit: number) {
    const survey = await this.db.query.csatSurveys.findFirst({
      where: and(eq(csatSurveys.id, surveyId), eq(csatSurveys.orgId, orgId)),
      columns: { id: true },
    });
    if (!survey) return null;

    return this.db.query.csatResponses.findMany({
      where: eq(csatResponses.surveyId, surveyId),
      orderBy: (t, { desc: descOp }) => [descOp(t.submittedAt)],
      limit,
    });
  }

  async submitResponse(surveyId: number, input: SubmitResponseInput) {
    const survey = await this.db.query.csatSurveys.findFirst({
      where: and(eq(csatSurveys.id, surveyId), eq(csatSurveys.status, "sent")),
      columns: { id: true, orgId: true, scaleMax: true },
    });

    if (!survey) return { error: "not_found" as const };

    if (input.rating < 1 || input.rating > survey.scaleMax) {
      return { error: "out_of_range" as const, scaleMax: survey.scaleMax };
    }

    await this.db.insert(csatResponses).values({
      surveyId: survey.id,
      orgId: survey.orgId,
      rating: input.rating,
      comment: input.comment ?? null,
      respondentName: input.respondentName ?? null,
      respondentEmail: input.respondentEmail ?? null,
    });

    return { submitted: true as const };
  }
}

export type SubmitResult = Awaited<ReturnType<CsatService["submitResponse"]>>;

export function isSubmitNotFound(
  result: SubmitResult,
): result is { error: "not_found" } {
  return "error" in result && result.error === "not_found";
}

export function isSubmitOutOfRange(
  result: SubmitResult,
): result is { error: "out_of_range"; scaleMax: number } {
  return "error" in result && result.error === "out_of_range";
}
