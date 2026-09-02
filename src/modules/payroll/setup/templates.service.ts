import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { SQL, and, asc, eq, getTableColumns, ilike, isNull, or, sql } from "drizzle-orm";
import { payrollTemplates } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { PAYROLL_TEMPLATE_SEEDS } from "./payroll-template-seeds";
import { computeTemplatePreview } from "./lib/template-preview";
import type { ListTemplatesInput, TemplatePreviewInput, DuplicateTemplateInput } from "./dto/setup.schemas";
import { DEFAULT_PAYROLL_TOGGLES } from "../payroll.types";
import type { TemplateComponentDef, PayrollToggles } from "../payroll.types";
import { buildCursorPage } from "../../../common/pagination/cursor";
import { keysetAfterValue } from "../../../common/pagination/keyset";
import {
  decodePayrollTextCursor,
  payrollCursorPosition,
} from "../payroll-cursor";

type TemplateRow = typeof payrollTemplates.$inferSelect;

export async function seedPayrollTemplates(db: Db): Promise<{ seeded: number; skipped: number }> {
  const existingRows = await db
    .select({ key: payrollTemplates.key })
    .from(payrollTemplates)
    .where(and(eq(payrollTemplates.isSystem, true), isNull(payrollTemplates.orgId)));

  const existingKeys = new Set<string>(
    existingRows.flatMap((r) => (r.key != null ? [r.key] : [])),
  );

  const newSeeds = PAYROLL_TEMPLATE_SEEDS.filter((seed) => !existingKeys.has(seed.key));

  if (newSeeds.length > 0) {
    await db.insert(payrollTemplates).values(
      newSeeds.map((seed) => ({
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
        defaultToggles: seed.defaultToggles,
        defaultComponents: seed.defaultComponents,
      })),
    );
  }

  return { seeded: newSeeds.length, skipped: PAYROLL_TEMPLATE_SEEDS.length - newSeeds.length };
}

@Injectable()
export class PayrollTemplatesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async ensureSystemTemplatesExist(): Promise<void> {
    // Hot path: if all system templates already exist, this GET stays read-only.
    // Only the first-ever call (empty catalog) falls through to seeding.
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(payrollTemplates)
      .where(and(eq(payrollTemplates.isSystem, true), isNull(payrollTemplates.orgId)));
    if (Number(row?.count ?? 0) >= PAYROLL_TEMPLATE_SEEDS.length) return;
    await seedPayrollTemplates(this.db);
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

  async list(orgId: string, input: ListTemplatesInput & { country?: string }) {
    await this.ensureSystemTemplatesExist();

    const filters: SQL[] = [or(isNull(payrollTemplates.orgId), eq(payrollTemplates.orgId, orgId)) as SQL];

    if (input.category) {
      filters.push(eq(payrollTemplates.category, input.category as TemplateRow["category"]));
    }
    if (input.complexity) {
      filters.push(eq(payrollTemplates.complexity, input.complexity));
    }
    if (input.search) {
      filters.push(
        or(
          ilike(payrollTemplates.name, `%${input.search}%`),
          ilike(payrollTemplates.description, `%${input.search}%`),
        ) as SQL,
      );
    }

    const country = input.country?.toUpperCase() ?? null;
    const cursorScope = [
      "templates",
      orgId,
      input.category ?? null,
      input.complexity ?? null,
      country,
      input.search ?? null,
    ] as const;
    const position = decodePayrollTextCursor(input.cursor, cursorScope);
    if (position) {
      filters.push(
        keysetAfterValue(payrollTemplates.name, payrollTemplates.id, {
          sortValue: position.value,
          id: String(position.id),
        }),
      );
    }

    const rows = await this.db
      .select(getTableColumns(payrollTemplates))
      .from(payrollTemplates)
      .where(and(...filters))
      .orderBy(asc(payrollTemplates.name), asc(payrollTemplates.id))
      .limit(input.limit + 1);

    const page = buildCursorPage(rows, input.limit, (row) =>
      payrollCursorPosition(cursorScope, [row.name], row.id),
    );
    const items = page.data.map((row) => ({
      ...row,
      isRecommended: this.computeIsRecommended(row, country ?? undefined),
    }));

    return { items, pagination: page.pagination };
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
    const rawComponents = template.defaultComponents;
    const components: TemplateComponentDef[] = Array.isArray(rawComponents) ? (rawComponents as TemplateComponentDef[]) : [];
    const overrides: Partial<PayrollToggles> = input.toggleOverrides && typeof input.toggleOverrides === "object" ? (input.toggleOverrides as Partial<PayrollToggles>) : {};
    const rawDefaultToggles = template.defaultToggles;
    const effectiveToggles: PayrollToggles = {
      ...DEFAULT_PAYROLL_TOGGLES,
      ...(rawDefaultToggles && typeof rawDefaultToggles === "object" ? (rawDefaultToggles as Partial<PayrollToggles>) : {}),
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
