import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import {
  onboardingTemplates,
  onboardingTemplateSteps,
  orgUnits,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import type { CreateTemplateInput } from "./dto/onboarding.schemas";

@Injectable()
export class OnboardingTemplateService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listTemplateDepartments(orgId: string) {
    return this.db
      .select({ id: orgUnits.id, name: orgUnits.name })
      .from(orgUnits)
      .where(
        and(
          eq(orgUnits.orgId, orgId),
          eq(orgUnits.kind, "DEPARTMENT"),
          isNull(orgUnits.deletedAt),
          eq(orgUnits.status, "ACTIVE"),
        ),
      )
      .orderBy(asc(orgUnits.name));
  }

  async listTemplates(orgId: string) {
    const templates = await this.db
      .select()
      .from(onboardingTemplates)
      .where(eq(onboardingTemplates.orgId, orgId))
      .orderBy(onboardingTemplates.createdAt);

    const templateIds = templates.map((t) => t.id);
    const steps =
      templateIds.length > 0
        ? await this.db
            .select()
            .from(onboardingTemplateSteps)
            .where(inArray(onboardingTemplateSteps.templateId, templateIds))
            .orderBy(onboardingTemplateSteps.sortOrder)
        : [];

    const stepsMap = new Map<number, typeof steps>();
    for (const step of steps) {
      const existing = stepsMap.get(step.templateId) ?? [];
      existing.push(step);
      stepsMap.set(step.templateId, existing);
    }

    return templates.map((t) => ({
      ...t,
      steps: stepsMap.get(t.id) ?? [],
    }));
  }

  createTemplate(orgId: string, userId: string, input: CreateTemplateInput) {
    return this.db.transaction(async (tx) => {
      const [template] = await tx
        .insert(onboardingTemplates)
        .values({
          orgId,
          name: input.name,
          departmentId: input.departmentId ?? null,
          description: input.description ?? null,
          isActive: true,
          createdBy: userId,
        })
        .returning();

      if (!template) {
        throw new Error("Failed to create template");
      }

      if (input.steps.length > 0) {
        await tx.insert(onboardingTemplateSteps).values(
          input.steps.map((step, i) => ({
            templateId: template.id,
            title: step.title,
            description: step.description ?? null,
            ownerRole: step.ownerRole,
            dueOffsetDays: step.dueOffsetDays,
            isRequired: step.isRequired,
            isComplianceItem: step.isComplianceItem,
            sortOrder: i,
          })),
        );
      }

      return { success: true, templateId: template.id };
    });
  }
}
