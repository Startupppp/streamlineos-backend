import type { CurrentUserContext } from "../../../../common/auth/backend-claims";

/*
 * The vocabulary of the CRM MCP surface: what a tool is, what a call names,
 * who is asking, and the catalogue itself. `CrmMcpService` re-exports the
 * three types and serves the catalogue as its `tools`.
 */

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  requiredPermission: string;
}

/**
 * Re-exported, not redeclared: the call's shape is owned by the schema that
 * validates it (`dto/crm-mcp.schemas.ts`). The declaration lives there rather
 * than being imported back into it, so this file stays the vocabulary and the
 * dto stays free of any dependency on it.
 */
export type { McpToolCall } from "../dto/crm-mcp.schemas";

/**
 * The caller, whole.
 *
 * This was `{ userId: string; orgId: string }`, and that pair is exactly what
 * could not express the thing this surface has to know: *which credential is
 * asking*. `AccessService.scopeFor` clamps an agent or personal token to its
 * own scopes, and it reads that ceiling off `user.principal` — a field the pair
 * did not carry. See `CrmMcpService.authorizeTool`.
 */
export type McpContext = CurrentUserContext;

/**
 * The complete catalogue of CRM MCP tools.
 *
 * A factory rather than a shared constant, so every `CrmMcpService` holds an
 * array of its own, as the class-field initialiser this came from gave it.
 */
export function crmMcpToolCatalogue(): McpToolDefinition[] {
  return [
    {
      name: "crm_list_parties",
      description: "List customer and prospect parties in the organization with pagination and search.",
      inputSchema: {
        type: "object",
        properties: {
          search: { type: "string", description: "Search by name, legal name or email" },
          page: { type: "number", description: "Page number (default 1)" },
          limit: { type: "number", description: "Page size (default 20, max 100)" },
        },
      },
      requiredPermission: "party:parties:view",
    },
    {
      name: "crm_get_party",
      description: "Get detailed information about a single party by partyId.",
      inputSchema: {
        type: "object",
        properties: {
          partyId: { type: "string", description: "The UUID of the party" },
        },
        required: ["partyId"],
      },
      requiredPermission: "party:parties:view",
    },
    {
      name: "crm_list_deals",
      description: "List pipeline deals in the organization with stage and assignee filters.",
      inputSchema: {
        type: "object",
        properties: {
          stage: { type: "string", description: "Filter by pipeline stage" },
          assignedToId: { type: "string", description: "Filter to one owner's deals" },
          offset: { type: "number", description: "Rows to skip (default 0)" },
          limit: { type: "number", description: "Items per page (max 100)" },
        },
      },
      requiredPermission: "crm:deals:read",
    },
    {
      name: "crm_get_deal",
      description: "Get comprehensive details of a single deal by dealId.",
      inputSchema: {
        type: "object",
        properties: {
          dealId: { type: "number", description: "The integer ID of the deal" },
        },
        required: ["dealId"],
      },
      requiredPermission: "crm:deals:read",
    },
    {
      name: "crm_list_activities",
      description:
        "Read the activity timeline (calls, emails, meetings, notes) for one party or one deal. An anchor is required.",
      inputSchema: {
        type: "object",
        properties: {
          partyId: { type: "string", description: "Anchor: the party whose timeline to read" },
          dealId: { type: "number", description: "Anchor: the deal whose timeline to read" },
          kind: { type: "string", description: "Filter by activity kind" },
          cursor: { type: "string", description: "Opaque cursor from the previous page" },
          limit: { type: "number", description: "Items per page (default 25, max 100)" },
        },
      },
      requiredPermission: "crm:activities:view",
    },
    {
      name: "crm_run_report",
      description: "Run an allowlisted CRM report query across parties, deals, or activities with bounded rows.",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", description: "Data source: parties, deals or activities" },
          limit: { type: "number", description: "Row cap (default 50, max 1000)" },
        },
        required: ["source"],
      },
      requiredPermission: "crm:reports:view",
    },
  ];
}
