import { z } from "zod";
import { nullableWireDate, wireDate } from "../../../../common/openapi/wire-types";

/**
 * The body of `POST /crm/mcp/call`: which tool, and its arguments.
 *
 * Only the envelope is checked here. Each tool's arguments are its own
 * contract (`inputSchema` in the catalogue), and `executeTool` resolves the
 * tool before anything reads them, so an unknown name is refused and audited
 * there rather than here. `arguments` defaults to `{}` because a tool that
 * takes none is still a call.
 */
export const mcpToolCallSchema = z.object({
  name: z.string().trim().min(1).max(128),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

/**
 * The call, typed FROM the schema that validates it.
 *
 * This shape used to be written twice — once here and once as a hand-written
 * `interface McpToolCall` in the tool catalogue — with nothing arbitrating the
 * two. The catalogue now re-exports this alias, so `executeTool` and the route's
 * `@Body()` parameter both move when the schema moves. `z.infer` is the OUTPUT
 * type, which is what the handler receives: `arguments` is required there because
 * `.default({})` has already filled it.
 */
export type McpToolCall = z.infer<typeof mcpToolCallSchema>;

/**
 * `GET /crm/mcp/tools`. The catalogue, already filtered to what the caller may
 * run — `getAvailableTools` returns `[]` outright when the organisation has
 * agent access switched off, so an empty list is a real answer and not an error.
 *
 * `inputSchema.properties` stays an open record because it IS one: each tool
 * publishes its own JSON Schema for its arguments, and re-describing those here
 * would be a second, drifting copy of the catalogue.
 */
export const mcpToolsResponseSchema = z.object({
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      inputSchema: z.object({
        type: z.literal("object"),
        properties: z.record(z.string(), z.unknown()),
        required: z.array(z.string()).optional(),
      }),
      requiredPermission: z.string(),
    }),
  ),
});

/**
 * `POST /crm/mcp/call`. The MCP content envelope, which is the protocol's shape
 * and not ours: every tool answers with text blocks, so a tool that returns rows
 * serialises them into one. A refusal never reaches here — it is a 403 or a 404
 * from `executeTool`.
 */
export const mcpToolCallResponseSchema = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
});

/**
 * `GET /crm/settings/mcp`. A missing row is synthesised rather than created, so
 * `updatedAt` is null for an organisation that has never touched the switch even
 * though the column is `NOT NULL` — the absence of a decision has no timestamp.
 */
export const mcpSettingsResponseSchema = z.object({
  organizationId: z.string(),
  enabled: z.boolean(),
  updatedByUserId: z.string().nullable(),
  updatedAt: nullableWireDate(),
});

/** `PUT /crm/settings/mcp` returns the upserted row, so `updatedAt` is always set. */
export const mcpSettingsWriteResponseSchema = z.object({
  organizationId: z.string(),
  enabled: z.boolean(),
  updatedByUserId: z.string().nullable(),
  updatedAt: wireDate(),
});
