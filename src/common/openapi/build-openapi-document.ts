import type { INestApplication } from "@nestjs/common";
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from "@nestjs/swagger";
import {
  normalizeOperationId,
  recordRouteClassification,
} from "../auth/record-route-classification";
import {
  CONTRACT_PARAMETERS,
  CONTRACT_RESPONSES,
  CONTRACT_SCHEMAS,
} from "./contract-components";
import {
  asRecord,
  scanOperationContracts,
  type JsonSchema,
  type OperationContract,
} from "./zod-operation-contracts";
import { PAGE_SIZE_CAP } from "../pagination/list-query.schema";

export const OPENAPI_TITLE = "StreamlineOS API";
export const OPENAPI_DESCRIPTION = "StreamlineOS platform REST API";
export const OPENAPI_DOCUMENT_VERSION = "1.0";

export interface BuiltDocument {
  document: OpenAPIObject;
  stamped: number;
  undeclared: number;
  contractsApplied: number;
  unconvertible: string[];
  errorResponsesApplied: number;
  pageSizeCapsApplied: number;
}

const PAGE_SIZE_PARAM_NAMES = new Set(["limit", "pageSize", "take", "perPage"]);

export function applyPageSizeCap(document: OpenAPIObject, cap: number): number {
  let count = 0;
  for (const pathItem of Object.values(document.paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const operation of Object.values(pathItem)) {
      if (!isOperation(operation)) continue;
      const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
      for (const parameter of parameters) {
        if (!isParameter(parameter)) continue;
        if (parameter.in !== "query") continue;
        if (typeof parameter.name !== "string") continue;
        if (!PAGE_SIZE_PARAM_NAMES.has(parameter.name)) continue;
        const rawSchema = parameter.schema;
        if (typeof rawSchema !== "object" || rawSchema === null) continue;
        const schema = rawSchema as Record<string, unknown>;
        if (schema["type"] !== "integer" && schema["type"] !== "number") continue;
        const currentMax = schema["maximum"];
        if (typeof currentMax === "number" && currentMax <= cap) continue;
        schema["maximum"] = cap;
        count++;
      }
    }
  }
  return count;
}

interface MutableOperation {
  operationId?: string;
  parameters?: unknown[];
  requestBody?: unknown;
  responses?: Record<string, unknown>;
  [key: string]: unknown;
}

interface MutableParameter {
  name?: unknown;
  in?: unknown;
  schema?: unknown;
  required?: unknown;
  $ref?: unknown;
}

const BODY_METHODS = new Set(["post", "put", "patch", "delete"]);

function isOperation(value: unknown): value is MutableOperation {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "operationId") === "string"
  );
}

function isParameter(value: unknown): value is MutableParameter {
  return typeof value === "object" && value !== null;
}

function propertiesOf(schema: JsonSchema): Record<string, JsonSchema> {
  const properties = schema.properties;
  if (typeof properties !== "object" || properties === null) return {};
  const out: Record<string, JsonSchema> = {};
  for (const [name, value] of Object.entries(properties)) {
    const record = asRecord(value);
    if (record !== undefined) out[name] = record;
  }
  return out;
}

function requiredOf(schema: JsonSchema): Set<string> {
  const required = schema.required;
  if (!Array.isArray(required)) return new Set();
  return new Set(
    required.filter((name): name is string => typeof name === "string"),
  );
}

function applyQuery(operation: MutableOperation, query: JsonSchema): void {
  const parameters = Array.isArray(operation.parameters)
    ? operation.parameters
    : [];
  const properties = propertiesOf(query);
  const required = requiredOf(query);

  for (const parameter of parameters) {
    if (!isParameter(parameter)) continue;
    if (parameter.in !== "query" || typeof parameter.name !== "string")
      continue;
    const schema = properties[parameter.name];
    if (!schema) continue;
    parameter.schema = schema;
    parameter.required = required.has(parameter.name);
  }

  const existing = new Set<string>();
  for (const parameter of parameters) {
    if (
      isParameter(parameter) &&
      parameter.in === "query" &&
      typeof parameter.name === "string"
    )
      existing.add(parameter.name);
  }

  const added: unknown[] = [];
  for (const [name, schema] of Object.entries(properties)) {
    if (existing.has(name)) continue;
    added.push({ name, in: "query", required: required.has(name), schema });
  }
  if (added.length > 0) operation.parameters = [...parameters, ...added];
}

function applyPathParams(
  operation: MutableOperation,
  params: JsonSchema,
): void {
  const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
  const properties = propertiesOf(params);

  for (const parameter of parameters) {
    if (!isParameter(parameter)) continue;
    if (parameter.in !== "path" || typeof parameter.name !== "string") continue;
    const schema = properties[parameter.name];
    if (schema) {
      parameter.schema = schema;
      parameter.required = true;
    }
  }

  const existing = new Set<string>();
  for (const parameter of parameters) {
    if (
      isParameter(parameter) &&
      parameter.in === "path" &&
      typeof parameter.name === "string"
    )
      existing.add(parameter.name);
  }

  const added: unknown[] = [];
  for (const [name, schema] of Object.entries(properties)) {
    if (existing.has(name)) continue;
    added.push({ name, in: "path", required: true, schema });
  }
  if (added.length > 0) operation.parameters = [...parameters, ...added];
}

/**
 * The published response body is the ENVELOPE, not the handler's return value.
 *
 * `ResponseTransformInterceptor` (registered in `main.ts`) wraps every handler return
 * that does not already carry a `success` key as `{ success: true, data }`. Until
 * 2026-09-03 this function published the un-enveloped shape, so the one operation in
 * the whole document that carried a 2xx schema — `GET /calendar/admin/settings` —
 * documented `{ sources }` while the wire actually carried
 * `{ success: true, data: { sources } }`. An external consumer generating a client
 * from that document would have read `sources` off the envelope and found undefined:
 * the single response contract this API published was wrong about the field it
 * described. `@ResponseSchema` still declares the handler's own shape, which is what a
 * service author can see and what the browser client validates after unwrapping
 * (`frontend/lib/api-envelope.ts` strips the envelope before applying its contract) —
 * the wrap belongs here, once, rather than in every schema.
 *
 * A schema that already declares `success` is describing a handler that returns its
 * own envelope, which the transform passes through untouched; it is published as-is.
 */
export function envelopeResponseSchema(schema: JsonSchema): JsonSchema {
  const properties = asRecord(schema["properties"]);
  if (properties && Object.hasOwn(properties, "success")) return schema;
  return {
    type: "object",
    properties: { success: { type: "boolean", enum: [true] }, data: schema },
    required: ["success", "data"],
    additionalProperties: false,
  };
}

function isBareSuccessKey(code: string, value: unknown): boolean {
  const num = Number(code);
  if (!(num >= 200 && num < 300)) return false;
  const record = asRecord(value);
  return record === undefined || !("content" in record);
}

function applyResponseSchema(
  method: string,
  operation: MutableOperation,
  schema: JsonSchema,
  status: number | undefined,
): void {
  const responses: Record<string, unknown> = operation.responses ?? {};
  const statusCode = String(status ?? (method === "post" ? 201 : 200));
  for (const code of Object.keys(responses))
    if (code !== statusCode && isBareSuccessKey(code, responses[code])) delete responses[code];
  const previous = asRecord(responses[statusCode]) ?? {};
  const metadata = Object.fromEntries(Object.entries(previous).filter(([key]) => key !== "$ref" && key !== "content"));
  responses[statusCode] = {
    ...metadata,
    description: typeof previous.description === "string" && previous.description.trim()
      ? previous.description
      : statusCode === "201" ? "Created" : "OK",
    content: { "application/json": { schema: envelopeResponseSchema(schema) } },
  };
  operation.responses = responses;
}

function applyNoContent(operation: MutableOperation): void {
  const responses: Record<string, unknown> = operation.responses ?? {};
  for (const code of Object.keys(responses))
    if (isBareSuccessKey(code, responses[code])) delete responses[code];
  responses["204"] = { description: "No Content", "x-no-content": true };
  operation.responses = responses;
}

export function applyErrorResponses(
  method: string,
  pathTemplate: string,
  operation: MutableOperation,
): void {
  const responses: Record<string, unknown> = operation.responses ?? {};
  const exposure = String(operation["x-exposure"] ?? "");
  const hasPathParam = pathTemplate.includes("{");
  const isMutating = BODY_METHODS.has(method);

  const ref = (name: string): unknown => ({ $ref: `#/components/responses/${name}` });

  const fill = (code: string, value: unknown): void => {
    if (!Object.hasOwn(responses, code)) responses[code] = value;
  };

  fill("400", ref("BadRequest"));
  if (exposure !== "public") fill("401", ref("Unauthorized"));
  if (exposure === "permissioned") fill("403", ref("Forbidden"));
  if (hasPathParam) fill("404", ref("NotFound"));
  if (isMutating) {
    fill("409", ref("Conflict"));
    fill("422", ref("UnprocessableEntity"));
  }
  fill("429", ref("TooManyRequests"));
  fill("503", ref("ServiceUnavailable"));

  operation.responses = responses;
}

function applyIdempotency(operation: MutableOperation, command: string): void {
  const parameters = Array.isArray(operation.parameters)
    ? operation.parameters
    : [];
  const alreadyReferenced = parameters.some(
    (parameter) =>
      isParameter(parameter) &&
      parameter.$ref === "#/components/parameters/IdempotencyKeyHeader",
  );
  if (!alreadyReferenced)
    operation.parameters = [
      ...parameters,
      { $ref: "#/components/parameters/IdempotencyKeyHeader" },
    ];
  operation["x-idempotency-command"] = command;
  operation["x-idempotent"] = true;
}

export function applyOperationContract(
  method: string,
  operation: MutableOperation,
  contract: OperationContract,
): void {
  if (contract.body && BODY_METHODS.has(method)) {
    operation.requestBody = {
      required: true,
      content: { "application/json": { schema: contract.body } },
    };
  }
  if (contract.multipart && BODY_METHODS.has(method)) {
    operation.requestBody = {
      required: true,
      content: { "multipart/form-data": { schema: contract.multipart } },
    };
  }
  if (contract.query) applyQuery(operation, contract.query);
  if (contract.params) applyPathParams(operation, contract.params);
  if (contract.idempotencyCommand)
    applyIdempotency(operation, contract.idempotencyCommand);
  if (contract.response) applyResponseSchema(method, operation, contract.response, contract.status);
  if (contract.noContent) applyNoContent(operation);
  if (contract.bodyless) operation["x-bodyless"] = true;
  if (contract.deprecated) operation["deprecated"] = true;
}

function sortRecord<T>(value: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function buildOpenApiDocument(app: INestApplication): BuiltDocument {
  const config = new DocumentBuilder()
    .setTitle(OPENAPI_TITLE)
    .setDescription(OPENAPI_DESCRIPTION)
    .setVersion(OPENAPI_DOCUMENT_VERSION)
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  const classification = recordRouteClassification(app, document);
  const { contracts, unconvertible } = scanOperationContracts(app);

  const components = document.components ?? {};
  components.schemas = sortRecord({
    ...CONTRACT_SCHEMAS,
    ...(components.schemas ?? {}),
  });
  components.parameters = sortRecord({
    ...CONTRACT_PARAMETERS,
    ...(components.parameters ?? {}),
  });
  components.responses = sortRecord({
    ...CONTRACT_RESPONSES,
    ...(components.responses ?? {}),
  });
  document.components = components;

  let contractsApplied = 0;
  let errorResponsesApplied = 0;
  for (const [pathTemplate, pathItem] of Object.entries(document.paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!isOperation(operation)) continue;
      const lmethod = method.toLowerCase();
      const contract = contracts.get(normalizeOperationId(String(operation.operationId)));
      if (contract) {
        applyOperationContract(lmethod, operation, contract);
        contractsApplied += 1;
      }
      applyErrorResponses(lmethod, pathTemplate, operation);
      errorResponsesApplied += 1;
    }
  }

  const pageSizeCapsApplied = applyPageSizeCap(document, PAGE_SIZE_CAP);

  document.paths = sortRecord(document.paths);

  return {
    document,
    stamped: classification.stamped,
    undeclared: classification.undeclared,
    contractsApplied,
    unconvertible: unconvertible.sort(),
    errorResponsesApplied,
    pageSizeCapsApplied,
  };
}
