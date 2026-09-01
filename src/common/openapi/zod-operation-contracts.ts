import { PATH_METADATA, ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { RouteParamtypes } from "@nestjs/common/enums/route-paramtypes.enum";
import { SetMetadata, type INestApplication } from "@nestjs/common";
import { DiscoveryService, MetadataScanner } from "@nestjs/core";
import { z, ZodType } from "zod";
import {
  VALIDATION_SCHEMAS,
  type ValidationSchemas,
} from "../validation/validate.decorator";
import { ZodValidationPipe } from "../pipes/zod-validation.pipe";
import { IDEMPOTENCY_COMMAND } from "../idempotency/idempotency.constants";
import { DEPRECATION_KEY } from "../deprecation/deprecated.decorator";

export const RESPONSE_SCHEMA = "openapi:response-schema";
export const BODYLESS_ACTION = "openapi:bodyless";
export const MULTIPART_ACTION = "openapi:multipart";

export const ResponseSchema = (schema: ZodType): MethodDecorator =>
  SetMetadata(RESPONSE_SCHEMA, schema);

export const BodylessAction = (): MethodDecorator =>
  SetMetadata(BODYLESS_ACTION, true);

export interface MultipartSpec {
  file: string;
  fileRequired?: boolean;
  additionalFiles?: string[];
  fields?: Record<string, "string" | "integer" | "number" | "boolean">;
  requiredFields?: string[];
}

export const MultipartAction = (spec: MultipartSpec): MethodDecorator =>
  SetMetadata(MULTIPART_ACTION, spec);

export function isMultipartSpec(value: unknown): value is MultipartSpec {
  if (typeof value !== "object" || value === null) return false;
  const file: unknown = (value as { file?: unknown }).file;
  return typeof file === "string" && file.length > 0;
}

export function multipartSchema(spec: MultipartSpec): JsonSchema {
  const properties: Record<string, JsonSchema> = {
    [spec.file]: { type: "string", format: "binary" },
  };
  for (const name of spec.additionalFiles ?? [])
    properties[name] = { type: "string", format: "binary" };
  for (const [name, type] of Object.entries(spec.fields ?? {}))
    properties[name] = { type };
  const required = [
    ...(spec.fileRequired === false ? [] : [spec.file]),
    ...(spec.requiredFields ?? []),
  ];
  return required.length > 0
    ? { type: "object", properties, required }
    : { type: "object", properties };
}

export interface OperationContract {
  body?: JsonSchema;
  query?: JsonSchema;
  params?: JsonSchema;
  idempotencyCommand?: string;
  response?: JsonSchema;
  bodyless?: true;
  multipart?: JsonSchema;
  deprecated?: true;
}

export type JsonSchema = Record<string, unknown>;

export interface ContractScanResult {
  contracts: Map<string, OperationContract>;
  converted: number;
  unconvertible: string[];
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = entry;
  return out;
}

type JsonSchemaResult = { ok: true; schema: JsonSchema } | { ok: false; reason: string };

function toJsonSchema(schema: ZodType): JsonSchemaResult {
  try {
    const converted: unknown = z.toJSONSchema(schema, {
      io: "input",
      unrepresentable: "any",
      target: "draft-7",
    });
    const record = asRecord(converted);
    if (!record) return { ok: false, reason: "z.toJSONSchema returned a non-object" };
    const { $schema: _ignored, ...rest } = record;
    return { ok: true, schema: rest };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function readValidationSchemas(handler: object): ValidationSchemas | undefined {
  const meta: unknown = Reflect.getMetadata(VALIDATION_SCHEMAS, handler);
  if (typeof meta !== "object" || meta === null) return undefined;
  return meta as ValidationSchemas;
}

const PARAM_TYPE_TO_PART: Partial<Record<number, keyof ValidationSchemas>> = {
  [RouteParamtypes.BODY]: "body",
  [RouteParamtypes.QUERY]: "query",
  [RouteParamtypes.PARAM]: "params",
};

function schemaFromPipes(pipes: unknown): ZodType | undefined {
  if (!Array.isArray(pipes)) return undefined;
  for (const pipe of pipes) {
    if (pipe instanceof ZodValidationPipe) {
      const raw: unknown = Reflect.get(pipe, "schema");
      if (raw instanceof ZodType) return raw;
    }
  }
  return undefined;
}

function readPipeSchemas(
  classRef: unknown,
  methodName: string,
): ValidationSchemas {
  const found: ValidationSchemas = {};
  if (typeof classRef !== "function") return found;

  const args: unknown = Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    classRef,
    methodName,
  );
  if (typeof args !== "object" || args === null) return found;

  for (const [key, descriptor] of Object.entries(args)) {
    const paramType = Number(key.split(":")[0]);
    const part = PARAM_TYPE_TO_PART[paramType];
    if (!part) continue;
    if (typeof descriptor !== "object" || descriptor === null) continue;
    if (Reflect.get(descriptor, "data") !== undefined) continue;

    const schema = schemaFromPipes(Reflect.get(descriptor, "pipes"));
    if (schema && !found[part]) found[part] = schema;
  }

  return found;
}

export function scanOperationContracts(
  app: INestApplication,
): ContractScanResult {
  const discovery = app.get(DiscoveryService);
  const scanner = app.get(MetadataScanner);

  const contracts = new Map<string, OperationContract>();
  const unconvertible: string[] = [];
  let converted = 0;

  for (const wrapper of discovery.getControllers()) {
    const { instance } = wrapper;
    if (!instance || typeof instance !== "object") continue;
    const proto: object = Object.getPrototypeOf(instance);
    const classRef = proto.constructor;

    for (const methodName of scanner.getAllMethodNames(proto)) {
      const handler: unknown = Reflect.get(proto, methodName);
      if (typeof handler !== "function") continue;
      if (Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue;

      const operationId = `${classRef.name}_${methodName}`;
      const contract: OperationContract = {};

      const schemas: ValidationSchemas = {
        ...readPipeSchemas(classRef, methodName),
        ...readValidationSchemas(handler),
      };
      for (const part of ["body", "query", "params"] as const) {
        const zodSchema = schemas[part];
        if (!zodSchema) continue;
        const result = toJsonSchema(zodSchema);
        if (result.ok) {
          contract[part] = result.schema;
          converted += 1;
        } else unconvertible.push(`${operationId}.${part}: ${result.reason}`);
      }

      const command: unknown = Reflect.getMetadata(
        IDEMPOTENCY_COMMAND,
        handler,
      );
      if (typeof command === "string" && command !== "")
        contract.idempotencyCommand = command;

      const responseRaw: unknown = Reflect.getMetadata(RESPONSE_SCHEMA, handler);
      if (responseRaw instanceof ZodType) {
        const result = toJsonSchema(responseRaw);
        if (result.ok) {
          contract.response = result.schema;
          converted += 1;
        } else unconvertible.push(`${operationId}.response: ${result.reason}`);
      }

      const isBodyless: unknown = Reflect.getMetadata(BODYLESS_ACTION, handler);
      if (isBodyless === true) contract.bodyless = true;

      const multipart: unknown = Reflect.getMetadata(MULTIPART_ACTION, handler);
      if (isMultipartSpec(multipart)) contract.multipart = multipartSchema(multipart);

      const isDeprecated: unknown = Reflect.getMetadata(DEPRECATION_KEY, handler);
      if (isDeprecated !== undefined && isDeprecated !== null) contract.deprecated = true;

      if (Object.keys(contract).length > 0)
        contracts.set(operationId, contract);
    }
  }

  return { contracts, converted, unconvertible };
}
