import { z } from "zod";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import {
  crmListPartiesInputSchema,
  crmGetPartyInputSchema,
  crmListDealsInputSchema,
  crmGetDealInputSchema,
  crmListActivitiesInputSchema,
  crmRunReportInputSchema,
} from "../dto/crm-mcp.schemas";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  requiredPermission: string;
}

export type { McpToolCall } from "../dto/crm-mcp.schemas";

export type McpContext = CurrentUserContext;

function toMcpInputSchema(schema: z.ZodObject<z.ZodRawShape>): McpToolDefinition["inputSchema"] {
  const json = z.toJSONSchema(schema);
  const rawProperties = json.properties;
  const properties: Record<string, unknown> = rawProperties
    ? Object.fromEntries(Object.entries(rawProperties))
    : {};
  const result: McpToolDefinition["inputSchema"] = { type: "object", properties };
  if (Array.isArray(json.required) && json.required.length > 0)
    result.required = [...json.required];
  if (typeof json.additionalProperties === "boolean")
    result.additionalProperties = json.additionalProperties;
  return result;
}

export function crmMcpToolCatalogue(): McpToolDefinition[] {
  return [
    {
      name: "crm_list_parties",
      description: "List customer and prospect parties in the organization with pagination and search.",
      inputSchema: toMcpInputSchema(crmListPartiesInputSchema),
      requiredPermission: "party:parties:view",
    },
    {
      name: "crm_get_party",
      description: "Get detailed information about a single party by partyId.",
      inputSchema: toMcpInputSchema(crmGetPartyInputSchema),
      requiredPermission: "party:parties:view",
    },
    {
      name: "crm_list_deals",
      description: "List pipeline deals in the organization with stage and assignee filters.",
      inputSchema: toMcpInputSchema(crmListDealsInputSchema),
      requiredPermission: "crm:deals:read",
    },
    {
      name: "crm_get_deal",
      description: "Get comprehensive details of a single deal by dealId.",
      inputSchema: toMcpInputSchema(crmGetDealInputSchema),
      requiredPermission: "crm:deals:read",
    },
    {
      name: "crm_list_activities",
      description:
        "Read the activity timeline (calls, emails, meetings, notes) for one party or one deal. An anchor is required.",
      inputSchema: toMcpInputSchema(crmListActivitiesInputSchema),
      requiredPermission: "crm:activities:view",
    },
    {
      name: "crm_run_report",
      description: "Run an allowlisted CRM report query across parties, deals, or activities with bounded rows.",
      inputSchema: toMcpInputSchema(crmRunReportInputSchema),
      requiredPermission: "crm:reports:view",
    },
  ];
}
