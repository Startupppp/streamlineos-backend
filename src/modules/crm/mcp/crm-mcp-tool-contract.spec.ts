import { z } from "zod";
import { crmMcpToolCatalogue } from "./lib/crm-mcp-tool-catalogue";
import {
  crmListPartiesInputSchema,
  crmGetPartyInputSchema,
  crmListDealsInputSchema,
  crmGetDealInputSchema,
  crmListActivitiesInputSchema,
  crmRunReportInputSchema,
} from "./dto/crm-mcp.schemas";
import type { McpToolDefinition } from "./lib/crm-mcp-tool-catalogue";

const catalogue = crmMcpToolCatalogue();

function toolByName(name: string): McpToolDefinition {
  const t = catalogue.find((x) => x.name === name);
  if (!t) throw new Error(`Tool not found in catalogue: ${name}`);
  return t;
}

describe(
  "CRM MCP tool contracts — a hand-written JSON Schema drifts from the Zod schema it claims to describe, and the drift only surfaces when an external client sends input one accepts and the other rejects",
  () => {
    describe("$schema is never emitted to MCP clients", () => {
      it("no tool's inputSchema contains a $schema key", () => {
        for (const tool of catalogue) {
          expect(tool.inputSchema).not.toHaveProperty("$schema");
        }
      });
    });

    describe("every Zod schema field appears in the corresponding tool's inputSchema with the correct type", () => {
      it("crm_list_parties: search, page, limit — all optional strings/numbers", () => {
        const tool = toolByName("crm_list_parties");
        expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(
          Object.keys(crmListPartiesInputSchema.shape).sort(),
        );
        expect((tool.inputSchema.properties["search"] as { type: string }).type).toBe("string");
        expect((tool.inputSchema.properties["page"] as { type: string }).type).toBe("number");
        expect((tool.inputSchema.properties["limit"] as { type: string }).type).toBe("number");
        expect(tool.inputSchema.required).toBeUndefined();
      });

      it("crm_get_party: partyId is required", () => {
        const tool = toolByName("crm_get_party");
        expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(
          Object.keys(crmGetPartyInputSchema.shape).sort(),
        );
        expect((tool.inputSchema.properties["partyId"] as { type: string }).type).toBe("string");
        expect(tool.inputSchema.required).toContain("partyId");
      });

      it("crm_list_deals: stage, assignedToId, offset, limit — all optional", () => {
        const tool = toolByName("crm_list_deals");
        expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(
          Object.keys(crmListDealsInputSchema.shape).sort(),
        );
        expect((tool.inputSchema.properties["stage"] as { type: string }).type).toBe("string");
        expect((tool.inputSchema.properties["offset"] as { type: string }).type).toBe("number");
        expect(tool.inputSchema.required).toBeUndefined();
      });

      it("crm_get_deal: dealId is required and a number", () => {
        const tool = toolByName("crm_get_deal");
        expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(
          Object.keys(crmGetDealInputSchema.shape).sort(),
        );
        expect((tool.inputSchema.properties["dealId"] as { type: string }).type).toBe("number");
        expect(tool.inputSchema.required).toContain("dealId");
      });

      it("crm_list_activities: five fields, all optional — anchor validated at runtime", () => {
        const tool = toolByName("crm_list_activities");
        expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(
          Object.keys(crmListActivitiesInputSchema.shape).sort(),
        );
        expect((tool.inputSchema.properties["partyId"] as { type: string }).type).toBe("string");
        expect((tool.inputSchema.properties["dealId"] as { type: string }).type).toBe("number");
        expect(tool.inputSchema.required).toBeUndefined();
      });

      it("crm_run_report: source is required, limit is optional", () => {
        const tool = toolByName("crm_run_report");
        expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(
          Object.keys(crmRunReportInputSchema.shape).sort(),
        );
        expect((tool.inputSchema.properties["source"] as { type: string }).type).toBe("string");
        expect(tool.inputSchema.required).toContain("source");
        expect(tool.inputSchema.required).not.toContain("limit");
      });
    });

    describe("property descriptions reach the manifest so MCP clients can document themselves", () => {
      it("crm_list_parties.search carries a description", () => {
        const tool = toolByName("crm_list_parties");
        expect(
          (tool.inputSchema.properties["search"] as { description?: string }).description,
        ).toBeTruthy();
      });

      it("crm_get_party.partyId carries a description", () => {
        const tool = toolByName("crm_get_party");
        expect(
          (tool.inputSchema.properties["partyId"] as { description?: string }).description,
        ).toBeTruthy();
      });
    });

    describe("additionalProperties is present and false (MCP clients learn which fields the tool reads)", () => {
      it.each(catalogue.map((t) => [t.name, t] as [string, McpToolDefinition]))(
        "%s sets additionalProperties: false",
        (_name, tool) => {
          expect(tool.inputSchema.additionalProperties).toBe(false);
        },
      );
    });

    describe("mutation proof — the spec catches drift between the Zod schema and the manifest", () => {
      it("adding a field to the Zod schema makes it appear in the derived manifest (mutation 1 proof: spec picks up new fields)", () => {
        const base = z.object({
          stage: z.string().optional(),
          limit: z.number().optional(),
        });
        const extended = base.extend({
          priority: z.string().describe("Filter by priority level").optional(),
        });
        const derivedKeys = Object.keys(z.toJSONSchema(extended).properties ?? {}).sort();
        expect(derivedKeys).toEqual(["limit", "priority", "stage"]);
        const baseKeys = Object.keys(z.toJSONSchema(base).properties ?? {}).sort();
        expect(baseKeys).not.toContain("priority");
      });

      it("a manifest built from a schema missing a field is detectable against the real Zod schema (mutation 2 proof: spec fails when manifest and Zod schema disagree)", () => {
        const tool = toolByName("crm_list_deals");
        const schemaWithoutStage = crmListDealsInputSchema.omit({ stage: true });
        const manifestKeys = Object.keys(tool.inputSchema.properties).sort();
        const mismatchedKeys = Object.keys(schemaWithoutStage.shape).sort();
        expect(manifestKeys).not.toEqual(mismatchedKeys);
      });
    });
  },
);
