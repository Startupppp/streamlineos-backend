import { NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { surveyForms } from "../../db/schema";
import { type Db } from "../../db/drizzle.module";
import type { ScopedRead } from "../access/scoped-read";

export async function assertSurveyInOrg(db: Db, orgId: string, surveyId: number): Promise<void> {
  const survey = await db.query.surveyForms.findFirst({
    columns: { id: true },
    where: and(eq(surveyForms.id, surveyId), eq(surveyForms.orgId, orgId)),
  });
  if (!survey) throw new NotFoundException("Survey not found");
}

/**
 * The same question as `assertSurveyInOrg`, asked with the caller's DataScope
 * instead of only their tenant — and it is a different question, because
 * `surveys:view` is `scopable: true`.
 *
 * `GET /surveys` and `GET /surveys/:surveyId` narrow to what the caller created;
 * the survey's CONTENT — its builder snapshot and its logic rules — did not, and
 * was reachable under the same key for any survey in the organisation. A holder
 * narrowed to `own` was refused the survey and handed its sections, questions,
 * choices and branching rules through the child routes. That is the
 * `/deals/export` shape `bola-scope-sibling-drift.spec.ts` exists to catch, and
 * the content reads are the larger half of it.
 *
 * `NotFoundException`, matching `SurveyFormsService.get`: a survey the caller's
 * scope excludes is answered exactly as one that does not exist, so narrowing
 * somebody's scope does not hand them an existence oracle over their colleagues'
 * drafts. At scope `none` no statement is issued at all — `ScopedRead` refuses
 * before it builds a predicate.
 */
export async function assertSurveyReadable(
  db: Db,
  read: ScopedRead,
  surveyId: number,
): Promise<void> {
  const notFound = (): never => {
    throw new NotFoundException("Survey not found");
  };

  await read.read(
    {
      tenant: surveyForms.orgId,
      scope: { columns: { ownerColumn: surveyForms.createdBy } },
      and: [eq(surveyForms.id, surveyId)],
    },
    async ({ sql: where }) => {
      const survey = await db.query.surveyForms.findFirst({ columns: { id: true }, where });
      if (!survey) notFound();
    },
    notFound,
  );
}
