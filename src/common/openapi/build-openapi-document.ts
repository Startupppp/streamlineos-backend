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

export const OPENAPI_TITLE = "StreamlineOS API";
export const OPENAPI_DESCRIPTION = "StreamlineOS platform REST API";
export const OPENAPI_DOCUMENT_VERSION = "1.0";

export interface BuiltDocument {
  document: OpenAPIObject;
  stamped: number;
  undeclared: number;
  contractsApplied: number;
  unconvertible: string[];
}

interface MutableOperation {
  operationId?: string;
  parameters?: unknown[];
  requestBody?: unknown;
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
  if (contract.query) applyQuery(operation, contract.query);
  if (contract.params) applyPathParams(operation, contract.params);
  if (contract.idempotencyCommand)
    applyIdempotency(operation, contract.idempotencyCommand);
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
  for (const pathItem of Object.values(document.paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!isOperation(operation)) continue;
      const contract = contracts.get(normalizeOperationId(String(operation.operationId)));
      if (!contract) continue;
      applyOperationContract(method.toLowerCase(), operation, contract);
      contractsApplied += 1;
    }
  }

  document.paths = sortRecord(document.paths);

  return {
    document,
    stamped: classification.stamped,
    undeclared: classification.undeclared,
    contractsApplied,
    unconvertible: unconvertible.sort(),
  };
}
