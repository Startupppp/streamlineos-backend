import { IsString, IsNotEmpty, IsOptional, IsArray, IsNumber, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import type { SnapshotCitation, SnapshotStructured } from "./ai-summaries.types";

class StructuredDto implements SnapshotStructured {
  @IsArray()
  @IsString({ each: true })
  highlights!: string[];

  @IsArray()
  @IsString({ each: true })
  blockers!: string[];

  @IsArray()
  @IsString({ each: true })
  nextActions!: string[];
}

class CitationDto implements SnapshotCitation {
  @IsNotEmpty()
  id!: string | number;

  @IsString()
  @IsNotEmpty()
  title!: string;

  @IsOptional()
  @IsString()
  href?: string;

  @IsOptional()
  @IsString()
  snippet?: string;

  @IsOptional()
  @IsString()
  freshness?: string;
}

export class SaveSnapshotDto {
  @IsString()
  @IsNotEmpty()
  summary!: string;

  @ValidateNested()
  @Type(() => StructuredDto)
  structured!: StructuredDto;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CitationDto)
  citations?: CitationDto[];

  @IsOptional()
  @IsString()
  correlationId?: string;

  @IsOptional()
  @IsNumber()
  confidence?: number;
}

export const ALLOWED_ENTITY_TYPES = [
  "project",
  "ticket",
  "support_ticket",
  "crm_account",
  "crm_deal",
] as const;

export type AllowedEntityType = (typeof ALLOWED_ENTITY_TYPES)[number];

export function isAllowedEntityType(value: string): value is AllowedEntityType {
  return (ALLOWED_ENTITY_TYPES as readonly string[]).includes(value);
}
