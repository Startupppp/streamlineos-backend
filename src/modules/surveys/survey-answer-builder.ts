import { surveyAnswers, surveyQuestionChoices, surveyResponseSessions } from "../../db/schema";
import type { SaveAnswerInput } from "./dto/survey-public.schemas";

export function buildSurveyAnswerRows(
  session: typeof surveyResponseSessions.$inferSelect,
  answers: SaveAnswerInput[],
  choicesByQuestion: Map<number, (typeof surveyQuestionChoices.$inferSelect)[]>,
): (typeof surveyAnswers.$inferInsert)[] {
  return answers.map((answer) => {
    let score: number | null = null;
    const choiceIds = answer.choiceIds;
    if (choiceIds?.length) {
      const choices = choicesByQuestion.get(answer.questionId) ?? [];
      const selected = choices.filter((c) => choiceIds.includes(c.id));
      if (selected.length) score = selected.reduce((sum, c) => sum + (c.score ?? 0), 0);
    }
    return {
      orgId: session.orgId,
      sessionId: session.id,
      surveyId: session.surveyId,
      versionId: session.versionId,
      questionId: answer.questionId,
      answerValue: answer.answerValue ?? null,
      answerText: answer.answerText ?? null,
      choiceIds: answer.choiceIds ?? null,
      score,
    };
  });
}
