import { z } from "zod";
import { ATTRIBUTION_MODELS } from "../../attribution/attribution-models";

/**
 * What the protocol surface accepts, declared without reaching into `db/`.
 *
 * The activity kinds are repeated here rather than imported from
 * `db/schema/crm/activities`, and that is not duplication by accident. The
 * capability layer's whole guarantee is that it has no value import reaching the
 * database — see `mcp-capability.ts` — and `db/schema` is the database. Pulling
 * one const out of it would put the schema barrel, and through it `drizzle-orm`,
 * into the capability layer's import graph, and the guarantee would then be a
 * comment rather than a fact.
 *
 * The two lists are pinned equal by `capabilities-cannot-reach-the-database.spec.ts`,
 * which is where a coupling like this belongs: a test may import anything, and a
 * drift between the two fails the build rather than 500ing at the first agent
 * that logs a meeting.
 */
export const MCP_ACTIVITY_KINDS = ["call", "email", "meeting", "note", "task"] as const;

/** A timeline is read for exactly one anchor, as it is everywhere else. */
export const mcpTimelineArgumentsSchema = z
  .object({
    partyId: z.string().trim().min(1).optional(),
    dealId: z.string().trim().min(1).optional(),
    subjectId: z.string().trim().min(1).optional(),
    kind: z.enum(MCP_ACTIVITY_KINDS).optional(),
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(25),
  })
  .strict()
  .refine(
    (value) => Boolean(value.partyId ?? value.dealId ?? value.subjectId),
    "A timeline is read for a party, a deal or a subject",
  );

export const mcpLogActivityArgumentsSchema = z
  .object({
    kind: z.enum(MCP_ACTIVITY_KINDS),
    partyId: z.string().trim().min(1).optional(),
    dealId: z.string().trim().min(1).optional(),
    subjectId: z.string().trim().min(1).optional(),
    occurredAt: z.string().datetime().optional(),
    subject: z.string().trim().max(500).optional(),
    body: z.string().max(20_000).optional(),
    threadId: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine(
    (value) => Boolean(value.partyId ?? value.dealId ?? value.subjectId),
    "An activity has to belong to a party, a deal or a subject",
  );

export const mcpReadDealArgumentsSchema = z
  .object({ dealId: z.number().int().positive() })
  .strict();

export const mcpListDealsArgumentsSchema = z
  .object({
    stage: z.string().trim().min(1).optional(),
    assignedToId: z.string().trim().min(1).optional(),
    limit: z.number().int().min(1).max(100).default(25),
    offset: z.number().int().min(0).default(0),
  })
  .strict();

export const mcpAttributionArgumentsSchema = z
  .object({
    model: z.enum(ATTRIBUTION_MODELS),
    from: z.string().datetime(),
    to: z.string().datetime(),
  })
  .strict()
  .refine(
    (value) => new Date(value.from).getTime() <= new Date(value.to).getTime(),
    "The window ends before it starts",
  );

/**
 * The JSON-RPC envelope the MCP transport speaks.
 *
 * `id` is echoed back untouched and is a client's own correlation key, so it is
 * permissive about type in the way the JSON-RPC spec is; `method` is not.
 */
export const mcpRequestSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number(), z.null()]).optional(),
    method: z.string().min(1),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const mcpToolCallParamsSchema = z
  .object({
    name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

/**
 * Turning the server on for a tenant, which is a decision somebody makes.
 *
 * `enabled` is required and there is no default, for the last criterion's sake:
 * a request that does not say cannot be read as a request to switch it on.
 */
export const setMcpEnablementSchema = z.object({ enabled: z.boolean() }).strict();

/**
 * The permission keys a token may exercise over the protocol.
 *
 * A full replacement rather than an add/remove pair. A grant list edited by
 * deltas drifts the moment two administrators edit it at once, and the failure
 * is silent and in the direction of MORE access than anybody chose.
 */
export const setTokenScopesSchema = z
  .object({
    permissions: z.array(z.string().trim().min(1)).max(100),
  })
  .strict();

export type McpRequest = z.infer<typeof mcpRequestSchema>;
export type SetMcpEnablementInput = z.infer<typeof setMcpEnablementSchema>;
export type SetTokenScopesInput = z.infer<typeof setTokenScopesSchema>;
