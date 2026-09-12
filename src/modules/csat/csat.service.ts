import { Inject, Injectable } from "@nestjs/common";
import { partyNamesFor } from "../party/party-names";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { csatResponses, csatSurveys } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { withPublicToken } from "../../common/tenant/with-public-token";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
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
        responses: { columns: { rating: true } },
      },
      orderBy: [desc(csatSurveys.createdAt)],
    });

    /**
     * The client's name from Party, not from `clients`. Ticket 08.
     *
     * `client_id` is still the identifier this survey was filed under and is
     * still returned as `client.id`, so nothing downstream changes shape; only
     * the *name* moved. That is the whole of what this service read the legacy
     * table for, and it is one of the twelve foreign keys standing between the
     * CRM and dropping it.
     */
    const names = await partyNamesFor(
      this.db,
      orgId,
      surveys.map((s) => s.clientPartyId),
    );

    return surveys.map((s) => {
      const { responses, ...rest } = s;
      const client = s.clientId
        ? { id: s.clientId, name: s.clientPartyId ? (names.get(s.clientPartyId) ?? null) : null }
        : null;
      const responseCount = responses.length;
      const avgRating =
        responseCount > 0
          ? responses.reduce((sum, r) => sum + r.rating, 0) / responseCount
          : null;
      return { ...rest, client, responseCount, avgRating };
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

  async getSurvey(orgId: string, surveyId: number) {
    const survey = await this.db.query.csatSurveys.findFirst({
      where: and(eq(csatSurveys.id, surveyId), eq(csatSurveys.orgId, orgId)),
      with: { responses: true },
    });
    if (!survey) return survey ?? null;

    // Ticket 08: same as the list path -- the identifier stays, the name comes
    // from Party, and the shape the caller sees is unchanged.
    const names = await partyNamesFor(this.db, orgId, [survey.clientPartyId]);

    return {
      ...survey,
      client: survey.clientId
        ? {
            id: survey.clientId,
            name: survey.clientPartyId ? (names.get(survey.clientPartyId) ?? null) : null,
          }
        : null,
    };
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

    await this.db
      .delete(csatSurveys)
      .where(and(eq(csatSurveys.id, surveyId), eq(csatSurveys.orgId, orgId)));

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

  async submitResponse(publicToken: string, input: SubmitResponseInput) {
    const survey = await withPublicToken(this.db, publicToken, (tx) =>
      tx.query.csatSurveys.findFirst({
        where: and(
          eq(csatSurveys.publicToken, publicToken),
          eq(csatSurveys.status, "sent"),
        ),
        columns: { id: true, orgId: true, scaleMax: true },
      }),
    );

    if (!survey) return { error: "not_found" as const };

    if (input.rating < 1 || input.rating > survey.scaleMax) {
      return { error: "out_of_range" as const, scaleMax: survey.scaleMax };
    }

    await runInNewTenantTransaction(this.db, survey.orgId, (tx) =>
      tx.insert(csatResponses).values({
        surveyId: survey.id,
        orgId: survey.orgId,
        rating: input.rating,
        comment: input.comment ?? null,
        respondentName: input.respondentName ?? null,
        respondentEmail: input.respondentEmail ?? null,
      }),
    );

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
