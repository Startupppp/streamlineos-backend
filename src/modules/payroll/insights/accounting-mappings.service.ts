import { Injectable, Inject, NotFoundException } from "@nestjs/common";
import { eq, and, asc } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { payrollAccountingMappings, salaryComponents } from "../../../db/schema";

@Injectable()
export class AccountingMappingsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string) {
    return this.db
      .select()
      .from(payrollAccountingMappings)
      .where(eq(payrollAccountingMappings.orgId, orgId))
      .orderBy(asc(payrollAccountingMappings.id));
  }

  async create(
    orgId: string,
    data: {
      componentId?: number;
      category?: string;
      ledgerName: string;
      costCenterSource?: string;
      notes?: string;
    },
  ) {
    if (data.componentId !== undefined) {
      const comp = await this.db
        .select({ id: salaryComponents.id })
        .from(salaryComponents)
        .where(and(eq(salaryComponents.id, data.componentId), eq(salaryComponents.orgId, orgId)))
        .limit(1);
      if (comp.length === 0) throw new NotFoundException("Salary component not found");
    }

    const rows = await this.db
      .insert(payrollAccountingMappings)
      .values({
        orgId,
        componentId: data.componentId ?? null,
        category: data.category ?? null,
        ledgerName: data.ledgerName,
        costCenterSource: data.costCenterSource ?? null,
        notes: data.notes ?? null,
      })
      .returning();

    const inserted = rows[0];
    if (inserted === undefined) throw new Error("Insert failed unexpectedly");
    return inserted;
  }

  async update(
    orgId: string,
    id: number,
    data: Partial<{
      componentId: number | null;
      category: string | null;
      ledgerName: string;
      costCenterSource: string | null;
      notes: string | null;
    }>,
  ) {
    const existing = await this.db
      .select({ id: payrollAccountingMappings.id })
      .from(payrollAccountingMappings)
      .where(and(eq(payrollAccountingMappings.id, id), eq(payrollAccountingMappings.orgId, orgId)))
      .limit(1);

    if (existing.length === 0) throw new NotFoundException("Accounting mapping not found");

    const setValues: Partial<typeof payrollAccountingMappings.$inferInsert> = {};
    if (data.componentId !== undefined) setValues.componentId = data.componentId;
    if (data.category !== undefined) setValues.category = data.category;
    if (data.ledgerName !== undefined) setValues.ledgerName = data.ledgerName;
    if (data.costCenterSource !== undefined) setValues.costCenterSource = data.costCenterSource;
    if (data.notes !== undefined) setValues.notes = data.notes;

    const rows = await this.db
      .update(payrollAccountingMappings)
      .set(setValues)
      .where(and(eq(payrollAccountingMappings.id, id), eq(payrollAccountingMappings.orgId, orgId)))
      .returning();

    const updated = rows[0];
    if (updated === undefined) throw new NotFoundException("Accounting mapping not found");
    return updated;
  }

  async remove(orgId: string, id: number): Promise<{ deleted: true }> {
    const existing = await this.db
      .select({ id: payrollAccountingMappings.id })
      .from(payrollAccountingMappings)
      .where(and(eq(payrollAccountingMappings.id, id), eq(payrollAccountingMappings.orgId, orgId)))
      .limit(1);

    if (existing.length === 0) throw new NotFoundException("Accounting mapping not found");

    await this.db
      .delete(payrollAccountingMappings)
      .where(and(eq(payrollAccountingMappings.id, id), eq(payrollAccountingMappings.orgId, orgId)));

    return { deleted: true };
  }

  async getMappings(orgId: string): Promise<Map<string, string>> {
    const mappings = await this.list(orgId);
    const map = new Map<string, string>();

    for (const mapping of mappings) {
      if (mapping.componentId !== null) {
        map.set(String(mapping.componentId), mapping.ledgerName);
      } else if (mapping.category !== null) {
        map.set(mapping.category, mapping.ledgerName);
      }
    }

    return map;
  }
}
