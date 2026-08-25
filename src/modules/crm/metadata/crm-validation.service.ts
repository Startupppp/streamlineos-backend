import { Inject, Injectable } from "@nestjs/common";
import { and, eq, ne } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { crmValidationRules } from "../../../db/schema";
import { businessParties, contactPartyMap, leadPartyMap } from "../../../db/schema/party";
import { PARTY_OF_CONTACT, PARTY_OF_LEAD } from "../crm-party-reads";

export interface ValidationContext {
  pipelineId?: string;
  stageKey?: string;
  sourceKey?: string;
  existingRecordId?: string;
}

export interface ValidationError {
  field: string;
  ruleType: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

type RuleRow = typeof crmValidationRules.$inferSelect;

function getValue(record: Record<string, unknown>, field: string): unknown {
  return record[field];
}

function isPresent(v: unknown): boolean {
  return v !== null && v !== undefined && v !== "";
}

@Injectable()
export class CrmValidationService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async evaluate(
    orgId: string,
    entityType: string,
    record: Record<string, unknown>,
    ctx: ValidationContext,
  ): Promise<ValidationResult> {
    const rules = await this.loadRules(orgId, entityType, ctx);
    const errors: ValidationError[] = [];

    for (const rule of rules) {
      const err = await this.applyRule(rule, record, ctx);
      if (err) errors.push(err);
    }

    return { valid: errors.length === 0, errors };
  }

  private async loadRules(orgId: string, entityType: string, ctx: ValidationContext): Promise<RuleRow[]> {
    const rows = await this.db.select().from(crmValidationRules).where(
      and(
        eq(crmValidationRules.orgId, orgId),
        eq(crmValidationRules.entityType, entityType),
        eq(crmValidationRules.isActive, true),
      ),
    ).orderBy(crmValidationRules.sortOrder);

    return rows.filter((r) => {
      if (r.stageKey && r.stageKey !== ctx.stageKey) return false;
      if (r.sourceKey && r.sourceKey !== ctx.sourceKey) return false;
      if (r.pipelineId && r.pipelineId !== ctx.pipelineId) return false;
      return true;
    });
  }

  private async applyRule(rule: RuleRow, record: Record<string, unknown>, ctx: ValidationContext): Promise<ValidationError | null> {
    const val = getValue(record, rule.field);
    const msg = rule.errorMessage ?? this.defaultMessage(rule.field, rule.ruleType);

    switch (rule.ruleType) {
      case "required":
        if (!isPresent(val)) return { field: rule.field, ruleType: rule.ruleType, message: msg };
        break;
      case "email":
        if (isPresent(val) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(val))) return { field: rule.field, ruleType: rule.ruleType, message: msg };
        break;
      case "phone":
        if (isPresent(val) && !/^\+?[\d\s\-().]{7,20}$/.test(String(val))) return { field: rule.field, ruleType: rule.ruleType, message: msg };
        break;
      case "url":
        if (isPresent(val)) {
          try { new URL(String(val)); } catch { return { field: rule.field, ruleType: rule.ruleType, message: msg }; }
        }
        break;
      case "regex": {
        const pattern = (rule.config as Record<string, unknown>)?.pattern;
        if (isPresent(val) && typeof pattern === "string") {
          if (!new RegExp(pattern).test(String(val))) return { field: rule.field, ruleType: rule.ruleType, message: msg };
        }
        break;
      }
      case "numeric_min": {
        const min = Number((rule.config as Record<string, unknown>)?.min);
        if (isPresent(val) && Number(val) < min) return { field: rule.field, ruleType: rule.ruleType, message: msg };
        break;
      }
      case "numeric_max": {
        const max = Number((rule.config as Record<string, unknown>)?.max);
        if (isPresent(val) && Number(val) > max) return { field: rule.field, ruleType: rule.ruleType, message: msg };
        break;
      }
      case "currency_min": {
        const cmin = Number((rule.config as Record<string, unknown>)?.min);
        if (isPresent(val) && Number(val) < cmin) return { field: rule.field, ruleType: rule.ruleType, message: msg };
        break;
      }
      case "currency_max": {
        const cmax = Number((rule.config as Record<string, unknown>)?.max);
        if (isPresent(val) && Number(val) > cmax) return { field: rule.field, ruleType: rule.ruleType, message: msg };
        break;
      }
      case "date_not_past":
        if (isPresent(val) && new Date(String(val)) < new Date()) return { field: rule.field, ruleType: rule.ruleType, message: msg };
        break;
      case "date_not_future":
        if (isPresent(val) && new Date(String(val)) > new Date()) return { field: rule.field, ruleType: rule.ruleType, message: msg };
        break;
      case "unique":
        if (isPresent(val)) {
          const dup = await this.checkUnique(rule, String(val), ctx.existingRecordId);
          if (dup) return { field: rule.field, ruleType: rule.ruleType, message: msg };
        }
        break;
      case "conditional_required": {
        const condField = String((rule.config as Record<string, unknown>)?.condField ?? "");
        const condValue = (rule.config as Record<string, unknown>)?.condValue;
        if (getValue(record, condField) === condValue && !isPresent(val)) return { field: rule.field, ruleType: rule.ruleType, message: msg };
        break;
      }
      case "stage_required":
        if (ctx.stageKey && rule.stageKey === ctx.stageKey && !isPresent(val)) return { field: rule.field, ruleType: rule.ruleType, message: msg };
        break;
      case "source_required":
        if (ctx.sourceKey && rule.sourceKey === ctx.sourceKey && !isPresent(val)) return { field: rule.field, ruleType: rule.ruleType, message: msg };
        break;
    }
    return null;
  }

  private async checkUnique(rule: RuleRow, value: string, existingId?: string): Promise<boolean> {
    if (rule.entityType === "lead") {
      const fieldCol = rule.field === "email" ? businessParties.email : rule.field === "phone" ? businessParties.phone : null;
      if (!fieldCol) return false;
      const conditions = [eq(leadPartyMap.organizationId, rule.orgId), eq(fieldCol, value)];
      if (existingId) conditions.push(ne(leadPartyMap.leadId, Number(existingId)));
      const [row] = await this.db
        .select({ id: leadPartyMap.leadId })
        .from(leadPartyMap)
        .innerJoin(businessParties, PARTY_OF_LEAD)
        .where(and(...conditions))
        .limit(1);
      return row !== undefined;
    }
    if (rule.entityType === "contact") {
      const fieldCol = rule.field === "email" ? businessParties.email : null;
      if (!fieldCol) return false;
      const conditions = [eq(contactPartyMap.organizationId, rule.orgId), eq(fieldCol, value)];
      if (existingId) conditions.push(ne(contactPartyMap.contactId, Number(existingId)));
      const [row] = await this.db
        .select({ id: contactPartyMap.contactId })
        .from(contactPartyMap)
        .innerJoin(businessParties, PARTY_OF_CONTACT)
        .where(and(...conditions))
        .limit(1);
      return row !== undefined;
    }
    return false;
  }

  private defaultMessage(field: string, ruleType: string): string {
    const messages: Record<string, string> = {
      required: `${field} is required`,
      email: `${field} must be a valid email address`,
      phone: `${field} must be a valid phone number`,
      url: `${field} must be a valid URL`,
      regex: `${field} format is invalid`,
      numeric_min: `${field} is below the minimum value`,
      numeric_max: `${field} exceeds the maximum value`,
      currency_min: `${field} is below the minimum amount`,
      currency_max: `${field} exceeds the maximum amount`,
      date_not_past: `${field} cannot be in the past`,
      date_not_future: `${field} cannot be in the future`,
      unique: `${field} must be unique`,
      conditional_required: `${field} is required under current conditions`,
      stage_required: `${field} is required at this stage`,
      source_required: `${field} is required for this source`,
    };
    return messages[ruleType] ?? `${field} is invalid`;
  }
}
