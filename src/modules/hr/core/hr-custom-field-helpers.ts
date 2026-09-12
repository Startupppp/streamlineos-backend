import { BadRequestException } from "@nestjs/common";
import { customFieldDefinitions } from "../../../db/schema/custom-field-engine";

export type HrFieldDef = {
  id: number;
  orgId: string;
  entityType: string;
  name: string;
  key: string;
  fieldType: string;
  options: Array<{ label: string; value: string }> | null | undefined;
  settings: typeof customFieldDefinitions.$inferSelect["settings"];
  isSensitive: boolean;
  isRequired: boolean;
  isActive: boolean;
  displayOrder: number;
  createdAt: Date;
  updatedAt: Date;
};

export function toHrFieldDef(row: typeof customFieldDefinitions.$inferSelect): HrFieldDef {
  return {
    id: row.id,
    orgId: row.orgId,
    entityType: row.entityType,
    name: row.label,
    key: row.key,
    fieldType: row.fieldType,
    options: row.options,
    settings: row.settings,
    isSensitive: row.isSensitive,
    isRequired: row.isRequired,
    isActive: row.isActive,
    displayOrder: row.displayOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function validateFieldValue(
  fieldType: string,
  value: unknown,
  isRequired: boolean,
): void {
  if (isRequired && (value === null || value === undefined || value === "")) {
    throw new BadRequestException("Required field value is missing");
  }
  if (value === null || value === undefined) return;
  if (fieldType === "number" || fieldType === "currency") {
    if (typeof value !== "number") throw new BadRequestException("Expected number value");
  }
  if (fieldType === "boolean") {
    if (typeof value !== "boolean") throw new BadRequestException("Expected boolean value");
  }
  if (fieldType === "date") {
    if (typeof value !== "string" || isNaN(Date.parse(value))) {
      throw new BadRequestException("Expected ISO date string");
    }
  }
}
