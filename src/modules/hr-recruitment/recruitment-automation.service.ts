import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, max, sql } from "drizzle-orm";
import {
  candidateMessages,
  candidates,
  emailSequenceEnrollments,
  emailSequenceSteps,
  emailSequences,
  pipelineAutomations,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type {
  CreateAutomationInput,
  CreateSequenceInput,
  EnrollSequenceInput,
  UpdateAutomationInput,
  UpdateSequenceInput,
} from "./dto/automation.schemas";

@Injectable()
export class RecruitmentAutomationService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listAutomations(orgId: string) {
    return this.db.query.pipelineAutomations.findMany({
      where: eq(pipelineAutomations.orgId, orgId),
      with: { creator: { columns: { id: true, name: true } } },
      orderBy: [desc(pipelineAutomations.createdAt)],
    });
  }

  async createAutomation(orgId: string, userId: string, input: CreateAutomationInput) {
    const [automation] = await this.db
      .insert(pipelineAutomations)
      .values({
        orgId,
        name: input.name,
        trigger: input.trigger,
        triggerConditions: input.triggerConditions ?? {},
        action: input.action,
        actionPayload: input.actionPayload ?? {},
        isActive: input.isActive ?? true,
        createdBy: userId,
      })
      .returning();
    return automation;
  }

  async updateAutomation(orgId: string, automationId: number, input: UpdateAutomationInput) {
    const updateData: Partial<typeof pipelineAutomations.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) updateData.name = input.name;
    if (input.isActive !== undefined) updateData.isActive = input.isActive;
    if (input.triggerConditions !== undefined) updateData.triggerConditions = input.triggerConditions;
    if (input.action !== undefined) updateData.action = input.action;
    if (input.actionPayload !== undefined) updateData.actionPayload = input.actionPayload;

    const [updated] = await this.db
      .update(pipelineAutomations)
      .set(updateData)
      .where(and(eq(pipelineAutomations.id, automationId), eq(pipelineAutomations.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Automation not found");
    return updated;
  }

  async deleteAutomation(orgId: string, automationId: number) {
    const [deleted] = await this.db
      .delete(pipelineAutomations)
      .where(and(eq(pipelineAutomations.id, automationId), eq(pipelineAutomations.orgId, orgId)))
      .returning({ id: pipelineAutomations.id });
    if (!deleted) throw new NotFoundException("Automation not found");
    return { success: true };
  }

  async markMessageRead(orgId: string, messageId: number) {
    const msg = await this.db.query.candidateMessages.findFirst({
      where: and(eq(candidateMessages.id, messageId), eq(candidateMessages.orgId, orgId)),
      columns: { id: true },
    });
    if (!msg) throw new NotFoundException("Message not found");

    const [updated] = await this.db
      .update(candidateMessages)
      .set({ readAt: new Date() })
      .where(eq(candidateMessages.id, messageId))
      .returning();
    return updated;
  }

  listMessageThreads(orgId: string) {
    return this.db
      .select({
        candidateId: candidateMessages.candidateId,
        lastMessageAt: max(candidateMessages.sentAt),
        messageCount: sql<number>`count(${candidateMessages.id})::int`,
        unreadCount: sql<number>`sum(case when ${candidateMessages.direction} = 'INBOUND' and ${candidateMessages.readAt} is null then 1 else 0 end)::int`,
        lastBody: sql<string>`(array_agg(${candidateMessages.body} order by ${candidateMessages.sentAt} desc))[1]`,
        lastDirection: sql<string>`(array_agg(${candidateMessages.direction} order by ${candidateMessages.sentAt} desc))[1]`,
        candidateFirstName: sql<string>`(array_agg(${candidates.firstName} order by ${candidateMessages.sentAt} desc))[1]`,
        candidateLastName: sql<string>`(array_agg(${candidates.lastName} order by ${candidateMessages.sentAt} desc))[1]`,
        candidateEmail: sql<string>`(array_agg(${candidates.email} order by ${candidateMessages.sentAt} desc))[1]`,
      })
      .from(candidateMessages)
      .leftJoin(candidates, eq(candidateMessages.candidateId, candidates.id))
      .where(eq(candidateMessages.orgId, orgId))
      .groupBy(candidateMessages.candidateId)
      .orderBy(desc(max(candidateMessages.sentAt)))
      .limit(100);
  }

  listSequences(orgId: string) {
    return this.db.query.emailSequences.findMany({
      where: eq(emailSequences.orgId, orgId),
      with: {
        steps: { orderBy: (s, { asc }) => [asc(s.stepOrder)] },
        enrollments: { columns: { id: true, status: true } },
        creator: { columns: { id: true, name: true } },
      },
      orderBy: [desc(emailSequences.createdAt)],
    });
  }

  async createSequence(orgId: string, userId: string, input: CreateSequenceInput) {
    return this.db.transaction(async (tx) => {
      const [sequence] = await tx
        .insert(emailSequences)
        .values({
          orgId,
          name: input.name,
          description: input.description,
          isActive: input.isActive ?? true,
          triggerType: input.triggerType,
          targetAudience: input.targetAudience ?? {},
          createdBy: userId,
        })
        .returning();

      if (input.steps.length > 0) {
        await tx.insert(emailSequenceSteps).values(
          input.steps.map((step) => ({
            sequenceId: sequence.id,
            stepOrder: step.stepOrder,
            delayDays: step.delayDays,
            subject: step.subject,
            htmlBody: step.htmlBody,
          })),
        );
      }

      return tx.query.emailSequences.findFirst({
        where: eq(emailSequences.id, sequence.id),
        with: { steps: { orderBy: (s, { asc }) => [asc(s.stepOrder)] } },
      });
    });
  }

  async getSequence(orgId: string, sequenceId: number) {
    const sequence = await this.db.query.emailSequences.findFirst({
      where: and(eq(emailSequences.id, sequenceId), eq(emailSequences.orgId, orgId)),
      with: {
        steps: { orderBy: (s, { asc }) => [asc(s.stepOrder)] },
        enrollments: { columns: { id: true, status: true, candidateId: true, nextSendAt: true } },
        creator: { columns: { id: true, name: true } },
      },
    });
    if (!sequence) throw new NotFoundException("Sequence not found");
    return sequence;
  }

  async updateSequence(orgId: string, sequenceId: number, input: UpdateSequenceInput) {
    return this.db.transaction(async (tx) => {
      const updateData: Partial<typeof emailSequences.$inferInsert> = { updatedAt: new Date() };
      if (input.name !== undefined) updateData.name = input.name;
      if (input.description !== undefined) updateData.description = input.description;
      if (input.isActive !== undefined) updateData.isActive = input.isActive;
      if (input.triggerType !== undefined) updateData.triggerType = input.triggerType;
      if (input.targetAudience !== undefined) updateData.targetAudience = input.targetAudience;

      const [updated] = await tx
        .update(emailSequences)
        .set(updateData)
        .where(and(eq(emailSequences.id, sequenceId), eq(emailSequences.orgId, orgId)))
        .returning();
      if (!updated) throw new NotFoundException("Sequence not found");

      if (input.steps !== undefined) {
        await tx.delete(emailSequenceSteps).where(eq(emailSequenceSteps.sequenceId, sequenceId));
        if (input.steps.length > 0) {
          await tx.insert(emailSequenceSteps).values(
            input.steps.map((step) => ({
              sequenceId,
              stepOrder: step.stepOrder,
              delayDays: step.delayDays,
              subject: step.subject,
              htmlBody: step.htmlBody,
            })),
          );
        }
      }

      return tx.query.emailSequences.findFirst({
        where: eq(emailSequences.id, sequenceId),
        with: { steps: { orderBy: (s, { asc }) => [asc(s.stepOrder)] } },
      });
    });
  }

  async deleteSequence(orgId: string, sequenceId: number) {
    const [deleted] = await this.db
      .delete(emailSequences)
      .where(and(eq(emailSequences.id, sequenceId), eq(emailSequences.orgId, orgId)))
      .returning({ id: emailSequences.id });
    if (!deleted) throw new NotFoundException("Sequence not found");
    return { success: true };
  }

  async enrollSequence(orgId: string, sequenceId: number, input: EnrollSequenceInput) {
    const sequence = await this.db.query.emailSequences.findFirst({
      where: and(eq(emailSequences.id, sequenceId), eq(emailSequences.orgId, orgId)),
      columns: { id: true, isActive: true },
    });
    if (!sequence) throw new NotFoundException("Sequence not found");
    if (!sequence.isActive) throw new BadRequestException("Sequence is inactive");

    const firstStep = await this.db.query.emailSequenceSteps.findFirst({
      where: eq(emailSequenceSteps.sequenceId, sequenceId),
      orderBy: (s, { asc }) => [asc(s.stepOrder)],
    });

    const nextSendAt = firstStep ? new Date(Date.now() + firstStep.delayDays * 86_400_000) : null;

    const rows = input.candidateIds.map((candidateId) => ({
      sequenceId,
      candidateId,
      currentStep: 0,
      status: "ACTIVE" as const,
      nextSendAt,
    }));

    await this.db.insert(emailSequenceEnrollments).values(rows).onConflictDoNothing();
    return { enrolled: rows.length };
  }
}
