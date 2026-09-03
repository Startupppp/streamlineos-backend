import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { surveyCollectors } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { assertSurveyInOrg } from "./survey-tenant";
import { withPublicToken } from "../../common/tenant/with-public-token";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import type { CreateCollectorInput, PatchCollectorInput } from "./dto/survey-collectors.schemas";

@Injectable()
export class SurveyCollectorService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string, surveyId: number) {
    await assertSurveyInOrg(this.db, orgId, surveyId);
    return this.db.query.surveyCollectors.findMany({
      where: and(eq(surveyCollectors.orgId, orgId), eq(surveyCollectors.surveyId, surveyId)),
      orderBy: [desc(surveyCollectors.createdAt)],
      limit: 100,
    });
  }

  async create(orgId: string, surveyId: number, input: CreateCollectorInput) {
    const [collector] = await this.db
      .insert(surveyCollectors)
      .values({
        orgId,
        surveyId,
        collectorType: input.collectorType,
        name: input.name,
        token: randomUUID(),
        source: input.source ?? null,
        utm: input.utm ?? {},
        settings: input.settings ?? {},
        expiresAt: input.expiresAt ?? null,
      })
      .returning();
    return collector;
  }

  async patch(orgId: string, surveyId: number, collectorId: number, input: PatchCollectorInput) {
    const [updated] = await this.db
      .update(surveyCollectors)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(surveyCollectors.id, collectorId), eq(surveyCollectors.orgId, orgId), eq(surveyCollectors.surveyId, surveyId)))
      .returning();
    if (!updated) throw new NotFoundException("Collector not found");
    return updated;
  }

  async getByToken(token: string) {
    const collector = await withPublicToken(this.db, token, (tx) =>
      tx.query.surveyCollectors.findFirst({
        where: eq(surveyCollectors.token, token),
        columns: { id: true, orgId: true },
      }),
    );
    if (!collector) throw new NotFoundException("Survey not found");

    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const full = await tx.query.surveyCollectors.findFirst({
          where: eq(surveyCollectors.token, token),
          with: { survey: true },
        });
        if (!full) throw new NotFoundException("Survey not found");
        return full;
      },
      { orgId: collector.orgId },
    );
  }

  async incrementCounter(collectorId: number, field: "opens" | "starts" | "completions") {
    await this.db
      .update(surveyCollectors)
      .set({ [field]: sql`COALESCE(${surveyCollectors[field]}, 0) + 1` })
      .where(eq(surveyCollectors.id, collectorId));
  }
}
