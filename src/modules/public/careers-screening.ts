import type { ScreeningQuestion } from "../../db/schema/hr/hiring-core";

/**
 * The screening questions a recruiter configured on a job, evaluated against
 * what the candidate answered — before anything is written.
 *
 * Pure, and separate from the apply service, because it is the only part of the
 * public apply that is a *policy* decision rather than a write: a knockout
 * answer must refuse the application without leaving a candidate row, an
 * application row or an outbox event behind, so it has to be decidable before
 * the transaction opens.
 */

export type ScreeningVerdict =
  | { outcome: "accepted"; answers: Record<string, string> }
  | { outcome: "missing"; questions: string[] }
  | { outcome: "knocked-out"; question: string; reason: string };

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * A knockout fires when the answer does NOT match `knockoutAnswer`.
 *
 * That direction is the one the recruiter UI describes ("required answer"), and
 * it is the safe one: a question configured as a knockout with no required
 * answer stated cannot silently reject everybody, it simply never fires.
 */
function knocksOut(question: ScreeningQuestion, answer: string): boolean {
  if (!question.knockout) return false;
  const required = question.knockoutAnswer;
  if (required === undefined || required.trim() === "") return false;
  return normalize(answer) !== normalize(required);
}

export function evaluateScreening(
  questions: readonly ScreeningQuestion[] | null,
  submitted: Record<string, string> | undefined,
): ScreeningVerdict {
  const answers: Record<string, string> = {};
  if (!questions || questions.length === 0) {
    /**
     * Answers to questions the job does not ask are dropped rather than stored.
     * The column is a public write target; keeping only keys the job declares
     * stops it becoming free storage for anyone who can reach the form.
     */
    return { outcome: "accepted", answers };
  }

  const missing: string[] = [];
  for (const question of questions) {
    const raw = submitted?.[question.id];
    const answer = typeof raw === "string" ? raw.trim() : "";
    if (answer === "") {
      if (question.required) missing.push(question.question);
      continue;
    }
    answers[question.id] = answer.slice(0, 2000);
  }

  if (missing.length > 0) return { outcome: "missing", questions: missing };

  for (const question of questions) {
    const answer = answers[question.id];
    if (answer === undefined) continue;
    if (knocksOut(question, answer))
      return {
        outcome: "knocked-out",
        question: question.question,
        reason: `This role requires "${question.knockoutAnswer ?? ""}" for: ${question.question}`,
      };
  }

  return { outcome: "accepted", answers };
}
