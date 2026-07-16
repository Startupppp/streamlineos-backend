import { IsNumber, IsOptional, IsString } from "class-validator";

export class VarianceExplainDto {
  @IsString()
  periodLabel!: string;

  @IsString()
  accountName!: string;

  @IsString()
  accountCode!: string;

  @IsNumber()
  budgetAmount!: number;

  @IsNumber()
  actualAmount!: number;

  @IsNumber()
  varianceAmount!: number;

  @IsNumber()
  variancePct!: number;

  @IsOptional()
  @IsNumber()
  priorPeriodAmount?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class ReconciliationExplainDto {
  @IsNumber()
  matchId!: number;
}

export class ExtractDocumentDto {
  @IsString()
  fileBase64!: string;

  @IsString()
  mimeType!: string;

  @IsString()
  sourceDocumentName!: string;
}
