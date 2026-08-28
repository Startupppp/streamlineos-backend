import type { OpenAPIObject } from "@nestjs/swagger";

type Components = NonNullable<OpenAPIObject["components"]>;
type Schemas = NonNullable<Components["schemas"]>;
type Parameters = NonNullable<Components["parameters"]>;
type Responses = NonNullable<Components["responses"]>;

export const ERROR_ENVELOPE_SCHEMA_REF = "#/components/schemas/ApiErrorEnvelope";

const ERROR_CODES = [
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "PAYMENT_REQUIRED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "UNPROCESSABLE_ENTITY",
  "RATE_LIMITED",
  "SERVICE_UNAVAILABLE",
  "VALIDATION_FAILED",
  "INTERNAL_ERROR",
];

export const CONTRACT_SCHEMAS: Schemas = {
  ApiErrorEnvelope: {
    type: "object",
    required: ["code", "message"],
    properties: {
      code: {
        type: "string",
        description:
          "Stable machine-readable code. Clients branch on this, never on the message text.",
        examples: ERROR_CODES,
      },
      message: { type: "string" },
      details: {
        description:
          "Present for VALIDATION_FAILED as an array of field issues; otherwise handler-defined.",
      },
    },
  },
  ValidationIssue: {
    type: "object",
    required: ["path", "message"],
    properties: {
      path: { type: "string" },
      message: { type: "string" },
    },
  },
  SuccessEnvelope: {
    type: "object",
    required: ["success", "data"],
    properties: {
      success: { type: "boolean", enum: [true] },
      data: {
        description:
          "The handler's own payload. A handler that already returns an object carrying `success` is passed through unwrapped.",
      },
    },
  },
  OffsetPagination: {
    type: "object",
    required: ["page", "limit", "total", "totalPages"],
    properties: {
      page: { type: "integer", minimum: 1 },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      total: { type: "integer", minimum: 0 },
      totalPages: { type: "integer", minimum: 0 },
    },
  },
  OffsetPage: {
    type: "object",
    required: ["data", "pagination"],
    properties: {
      data: { type: "array", items: {} },
      pagination: { $ref: "#/components/schemas/OffsetPagination" },
    },
  },
  CursorPage: {
    type: "object",
    required: ["data"],
    properties: {
      data: { type: "array", items: {} },
      nextCursor: {
        type: "string",
        nullable: true,
        description:
          "Absent or null when the page is the last one. A full page means there may be more; a short page is the end.",
      },
    },
  },
};

export const CONTRACT_PARAMETERS: Parameters = {
  PageParam: {
    name: "page",
    in: "query",
    required: false,
    schema: { type: "integer", minimum: 1, default: 1 },
    description: "Offset pagination. Bounded administration lists only.",
  },
  LimitParam: {
    name: "limit",
    in: "query",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
    description: "Hard cap of 100 per page on every list endpoint, public included.",
  },
  CursorParam: {
    name: "cursor",
    in: "query",
    required: false,
    schema: { type: "string" },
    description:
      "Keyset pagination for unbounded or high-churn lists. The cursor is the last id on the previous page.",
  },
  SearchParam: {
    name: "search",
    in: "query",
    required: false,
    schema: { type: "string" },
  },
  SortByParam: {
    name: "sortBy",
    in: "query",
    required: false,
    schema: { type: "string" },
  },
  SortDirectionParam: {
    name: "sortDirection",
    in: "query",
    required: false,
    schema: { type: "string", enum: ["asc", "desc"], default: "desc" },
  },
  IdempotencyKeyHeader: {
    name: "Idempotency-Key",
    in: "header",
    required: true,
    schema: { type: "string", maxLength: 255 },
    description:
      "Required on fenced commands. The first request executes and its response is stored; a completed retry replays it, a concurrent duplicate is rejected 409, and the same key with a different body is rejected 422.",
  },
};

function errorResponse(description: string): Responses[string] {
  return {
    description,
    content: {
      "application/json": { schema: { $ref: ERROR_ENVELOPE_SCHEMA_REF } },
    },
  };
}

export const CONTRACT_RESPONSES: Responses = {
  BadRequest: errorResponse("Malformed request or a failed Zod validation."),
  Unauthorized: errorResponse("Missing, expired or revoked credentials."),
  Forbidden: errorResponse(
    "Authenticated inside the correct tenant but lacking the permission. A resource in another tenant returns 404, never 403.",
  ),
  NotFound: errorResponse(
    "The resource does not exist, or exists in another tenant.",
  ),
  Conflict: errorResponse(
    "A conflicting write, or a fenced command whose identical request is still in flight.",
  ),
  UnprocessableEntity: errorResponse(
    "A reused Idempotency-Key sent with a different request body.",
  ),
  TooManyRequests: errorResponse("The caller exceeded its rate-limit tier."),
  ServiceUnavailable: errorResponse("A transient dependency failure. Retry."),
};
