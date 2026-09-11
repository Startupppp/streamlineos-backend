import { NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { surveyForms } from "../../db/schema";
import { type Db } from "../../db/drizzle.module";

export async function assertSurveyInOrg(db: Db, orgId: string, surveyId: number): Promise<void> {
  const survey = await db.query.surveyForms.findFirst({
    columns: { id: true },
    where: and(eq(surveyForms.id, surveyId), eq(surveyForms.orgId, orgId)),
  });
  if (!survey) throw new NotFoundException("Survey not found");
}
