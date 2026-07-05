import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, ilike, isNull, or, SQL } from "drizzle-orm";
import { payrollTemplates } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { PAYROLL_TEMPLATE_SEEDS } from "./payroll-template-seeds";
import { computeTemplatePreview } from "./lib/template-preview";
import type { ListTemplatesInput, TemplatePreviewInput, DuplicateTemplateInput } from "./dto/setup.schemas";
import type { PayrollTemplateSeed, TemplateComponentDef, PayrollToggles } from "../payroll.types";

type TemplateRow = typeof payrollTemplates.$inferSelect;

export async function seedPayrollTemplates(db: Db): Promise<{ seeded: number; skipped: number }> {
  let seeded = 0;
  let skipped = 0;

  for (const seed of PAYROLL_TEMPLATE_SEEDS) {
    const existing = await db.query.payrollTemplates.findFirst({
      where: and(
        eq(payrollTemplates.key, seed.key),
        eq(payrollTemplates.isSystem, true),
        isNull(payrollTemplates.orgId),
      ),
      columns: { id: true },
    });

    if (existing) {
      skipped += 1;
      continue;
    }

    await db.insert(payrollTemplates).values({
      orgId: null,
      key: seed.key,
      name: seed.name,
      description: seed.description,
      bestFor: seed.bestFor,
      complexity: seed.complexity,
      badge: seed.badge ?? null,
      category: seed.category,
      isSystem: true,
      isRecommended: seed.isRecommended,
      defaultToggles: seed.defaultToggles as unknown as Record<string, boolean>,
      defaultComponents: seed.defaultComponents as unknown as Record<string, unknown>[],
    });
    seeded += 1;
  }

  return { seeded, skipped };
}

@Injectable()
export class PayrollTemplatesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async ensureSystemTemplatesExist(): Promise<void> {
    const count = await this.db.query.payrollTemplates.findFirst({
      where: and(eq(payrollTemplates.isSystem, true), isNull(payrollTemplates.orgId)),
      columns: { id: true },
    });
    if (!count) {
      await seedPayrollTemplates(this.db);
    }
  }

  private computeIsRecommended(row: TemplateRow, country: string | undefined): boolean {
    if (!country) return row.isRecommended;
    const key = row.key ?? "";
    const countryUpper = country.toUpperCase();
    if (countryUpper === "IN") {
      return ["INDIAN_STANDARD", "INDIAN_STARTUP"].includes(key);
    }
    const COUNTRY_TEMPLATE_MAP: Record<string, string> = {
      US: "US_STANDARD",
      GB: "UK_STANDARD",
      AE: "UAE_STANDARD",
      SG: "SG_STANDARD",
      AU: "AU_STANDARD",
    };
    const recommendedKey = COUNTRY_TEMPLATE_MAP[countryUpper];
    return recommendedKey != null && key === recommendedKey;
  }

  async list(orgId: string, input: ListTemplatesInput & { country?: string }): Promise<{ items: (TemplateRow & { isRecommended: boolean })[]; total: number }> {
    await this.ensureSystemTemplatesExist();

    const filters: SQL[] = [or(isNull(payrollTemplates.orgId), eq(payrollTemplates.orgId, orgId)) as SQL];

    if (input.category) {
      filters.push(eq(payrollTemplates.category, input.category as TemplateRow["category"]));
    }
    if (input.search) {
      filters.push(
        or(
          ilike(payrollTemplates.name, `%${input.search}%`),
          ilike(payrollTemplates.description, `%${input.search}%`),
        ) as SQL,
      );
    }

    const where = and(...filters);
    const offset = (input.page - 1) * input.pageSize;

    const rows = await this.db
      .select()
      .from(payrollTemplates)
      .where(where)
      .limit(input.pageSize)
      .offset(offset);

    const allItems = await this.db
      .select({ id: payrollTemplates.id })
      .from(payrollTemplates)
      .where(where);

    const items = rows.map((row) => ({
      ...row,
      isRecommended: this.computeIsRecommended(row, input.country),
    }));

    return { items, total: allItems.length };
  }

  async getById(orgId: string, templateId: number): Promise<TemplateRow> {
    const template = await this.db.query.payrollTemplates.findFirst({
      where: and(
        eq(payrollTemplates.id, templateId),
        or(isNull(payrollTemplates.orgId), eq(payrollTemplates.orgId, orgId)),
      ),
    });
    if (!template) throw new NotFoundException("Template not found");
    return template;
  }

  async duplicate(orgId: string, templateId: number, input: DuplicateTemplateInput): Promise<TemplateRow> {
    const source = await this.getById(orgId, templateId);

    const [created] = await this.db
      .insert(payrollTemplates)
      .values({
        orgId,
        key: null,
        name: input.name,
        description: input.description ?? source.description,
        bestFor: source.bestFor,
        complexity: source.complexity,
        badge: null,
        category: source.category,
        isSystem: false,
        isRecommended: false,
        defaultToggles: source.defaultToggles,
        defaultComponents: source.defaultComponents,
      })
      .returning();

    return created;
  }

  async preview(orgId: string, templateId: number, input: TemplatePreviewInput) {
    const template = await this.getById(orgId, templateId);
    const components = template.defaultComponents as unknown as TemplateComponentDef[];
    const overrides = (input.toggleOverrides ?? {}) as Partial<PayrollToggles>;
    const effectiveToggles = {
      ...(template.defaultToggles as unknown as PayrollToggles),
      ...overrides,
    };
    const preview = computeTemplatePreview(components, input.annualCtc);
    return { template: { id: template.id, key: template.key, name: template.name }, effectiveToggles, ...preview };
  }

  async getByKey(key: string): Promise<TemplateRow | undefined> {
    return this.db.query.payrollTemplates.findFirst({
      where: and(
        eq(payrollTemplates.key, key),
        eq(payrollTemplates.isSystem, true),
        isNull(payrollTemplates.orgId),
      ),
    });
  }

  async assertOrgOwnsTemplate(orgId: string, templateId: number): Promise<TemplateRow> {
    const template = await this.db.query.payrollTemplates.findFirst({
      where: and(eq(payrollTemplates.id, templateId), eq(payrollTemplates.orgId, orgId)),
    });
    if (!template) throw new NotFoundException("Custom template not found");
    return template;
  }

  async deleteCustomTemplate(orgId: string, templateId: number): Promise<{ success: boolean }> {
    const template = await this.assertOrgOwnsTemplate(orgId, templateId);
    if (template.isSystem) throw new ConflictException("Cannot delete system templates");
    await this.db
      .delete(payrollTemplates)
      .where(and(eq(payrollTemplates.id, templateId), eq(payrollTemplates.orgId, orgId)));
    return { success: true };
  }
}
