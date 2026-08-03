import { SetMetadata } from "@nestjs/common";
import type { ZodType } from "zod";

export const VALIDATION_SCHEMAS = "validation:schemas";

export interface ValidationSchemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}


export const Validate = (schemas: ValidationSchemas) =>
  SetMetadata(VALIDATION_SCHEMAS, schemas);
