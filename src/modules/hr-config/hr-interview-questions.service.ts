import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, ilike, sql } from "drizzle-orm";
import { interviewQuestions } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type {
  CreateInterviewQuestionInput,
  InterviewQuestionListQuery,
  UpdateInterviewQuestionInput,
} from "./dto/interview-questions.schemas";

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((v) => v.toLowerCase().trim()).filter(Boolean))];
}

@Injectable()
export class HrInterviewQuestionsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  list(orgId: string, query: InterviewQuestionListQuery) {
    const conditions = [eq(interviewQuestions.orgId, orgId), eq(interviewQuestions.isActive, true)];
    if (query.category) conditions.push(eq(interviewQuestions.category, query.category));
    if (query.role) conditions.push(eq(interviewQuestions.role, query.role));
    if (query.difficulty) conditions.push(eq(interviewQuestions.difficulty, query.difficulty));
    if (query.q) conditions.push(ilike(interviewQuestions.question, `%${query.q}%`));

    return this.db.query.interviewQuestions.findMany({
      where: and(...conditions),
      orderBy: [desc(interviewQuestions.createdAt)],
      limit: 200,
    });
  }

  getById(orgId: string, id: number) {
    return this.db.query.interviewQuestions
      .findFirst({ where: and(eq(interviewQuestions.id, id), eq(interviewQuestions.orgId, orgId)) })
      .then((row) => row ?? null);
  }

  async create(orgId: string, userId: string, input: CreateInterviewQuestionInput) {
    const existing = await this.db.query.interviewQuestions.findFirst({
      where: and(
        eq(interviewQuestions.orgId, orgId),
        eq(interviewQuestions.isActive, true),
        sql`lower(trim(${interviewQuestions.question})) = ${input.question.trim().toLowerCase()}`,
      ),
      columns: { id: true },
    });
    if (existing) throw new ConflictException("A question with this text already exists in the bank.");

    const [created] = await this.db
      .insert(interviewQuestions)
      .values({
        orgId,
        question: input.question,
        category: input.category,
        role: input.role ?? null,
        difficulty: input.difficulty,
        tags: dedupe(input.tags),
        sampleAnswer: input.sampleAnswer ?? null,
        keywords: dedupe(input.keywords),
        createdBy: userId,
      })
      .returning();

    return created;
  }

  async update(orgId: string, id: number, input: UpdateInterviewQuestionInput) {
    const updateData: Partial<typeof interviewQuestions.$inferInsert> = { ...input, updatedAt: new Date() };
    if (input.tags) updateData.tags = dedupe(input.tags);
    if (input.keywords) updateData.keywords = dedupe(input.keywords);

    await this.db
      .update(interviewQuestions)
      .set(updateData)
      .where(and(eq(interviewQuestions.id, id), eq(interviewQuestions.orgId, orgId)));

    return { success: true };
  }

  async softDelete(orgId: string, id: number) {
    await this.db
      .update(interviewQuestions)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(interviewQuestions.id, id), eq(interviewQuestions.orgId, orgId)));

    return { success: true };
  }
}
