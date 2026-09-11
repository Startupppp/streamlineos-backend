import { BadRequestException } from "@nestjs/common";
import type { AuthResult } from "../../../access/access.types";
import type { PartyService } from "../../../party/party.service";
import type { DealsService } from "../../../deals/deals.service";
import type { ActivitiesService } from "../../../activities/activities.service";
import type { ReportingService } from "../../../reporting/reporting.service";
import { listPartiesQuerySchema } from "../../../party/dto/party.schemas";
import { listDealsSchema } from "../../../deals/dto/deals.schemas";
import { timelineQuerySchema } from "../../../activities/dto/activity.schemas";
import { asQueryDescription, queryDescriptionSchema } from "../../../reporting/dto/reporting.schemas";
import type { McpContext, McpToolDefinition } from "./crm-mcp-tool-catalogue";
import { ScopedRead } from "../../../access/scoped-read";

/**
 * What each report source returns to an agent.
 *
 * Fixed per source and named from `REPORTING_REGISTRY`, the closed set the
 * compiler resolves against — a name absent from it is refused at compile time
 * rather than becoming a column. An agent chooses the source; it does not name
 * columns, because inventing a field name here is exactly how the previous
 * version failed: it asked for `["id", "name", "value"]` on every source, and
 * not one of those three is a field of any of them.
 *
 * A `Map`, for the reason `REPORTING_REGISTRY` is one: `source` is a string the
 * caller chose, and looking it up in a plain object reaches the prototype —
 * `"__proto__"` returns `Object.prototype` and `"constructor"` returns a
 * function, both truthy, so the `if (!select)` below would treat them as found.
 * Zod refuses the description a step later either way, so the old shape failed
 * closed; it failed closed with a shape error about a source that does not
 * exist, instead of saying which sources do.
 */
const MCP_REPORT_PROJECTIONS: ReadonlyMap<string, { kind: "field"; field: string }[]> =
  new Map([
    [
      "parties",
      [
        { kind: "field" as const, field: "name" },
        { kind: "field" as const, field: "party_type" },
        { kind: "field" as const, field: "status" },
      ],
    ],
    [
      "deals",
      [
        { kind: "field" as const, field: "name" },
        { kind: "field" as const, field: "stage" },
        { kind: "field" as const, field: "value_minor" },
      ],
    ],
    [
      "activities",
      [
        { kind: "field" as const, field: "kind" },
        { kind: "field" as const, field: "subject" },
        { kind: "field" as const, field: "occurred_at" },
      ],
    ],
  ]);

/** The four services the tools read through, held with their real types. */
export interface CrmMcpToolServices {
  readonly partyService: PartyService;
  readonly dealsService: DealsService;
  readonly activitiesService: ActivitiesService;
  readonly reportingService: ReportingService;
}

/**
 * Run one tool's handler and return what its service answered.
 *
 * Called by `CrmMcpService.executeTool` only after the tenant switch, the tool
 * lookup and `authorize` have all let the call through. `decision` is that
 * allow, carrying the caller's DataScope already clamped to a token's ceiling,
 * and it is the only scope a handler here passes on.
 */
export async function runCrmMcpTool(
  services: CrmMcpToolServices,
  context: McpContext,
  tool: McpToolDefinition,
  decision: AuthResult,
  args: Record<string, unknown>,
): Promise<unknown> {
  let result: unknown;

  /*
   * The four services are called directly, with their real types. That is the
   * fix here, not a tidy-up.
   *
   * This block used to cast each one to `Record<string, Function>` and probe
   * it — `if (typeof svc.list === "function") … else if (typeof svc.listParties
   * === "function")`. No service has a `list`, a `findOne` or a `preview`, so
   * every first branch was dead and only the fallbacks ever ran; and because
   * the cast erased the signatures, nothing checked what the fallbacks were
   * handed. Every handler disagreed with the service it called, and the file
   * compiled clean:
   *
   *   crm_list_parties     sent `query`; the schema and the service read
   *                        `search`, so an agent's search term was dropped and
   *                        every call returned page one of everything.
   *   crm_list_deals       sent `page`, `pipelineId` and `stageId`; the input
   *                        has `offset` and `stage` and no notion of a
   *                        pipeline — three of its four advertised filters did
   *                        nothing, and paging was impossible.
   *   crm_list_activities  sent `page` to a keyset timeline that pages on
   *                        `cursor`, and could pass no anchor at all, which
   *                        falls through to `subject_id = ''` and matches
   *                        nothing.
   *   crm_get_party        did `String(args.partyId)` and then tested the
   *                        result for emptiness. `String(undefined)` is
   *                        `"undefined"`, which is truthy, so a missing id was
   *                        looked up as that literal string instead of refused.
   *   crm_run_report       sent `fields` where the description takes `select`,
   *                        naming fields that are in no source's registry, and
   *                        omitted the required `limit` — three independent
   *                        errors under one `as any`. It answered 400 to every
   *                        call ever made to it.
   *
   * Arguments are parsed by each module's own Zod schema rather than re-coerced
   * by hand here, which is what stops the two surfaces drifting apart again:
   * the bounds an agent gets are the bounds the HTTP route enforces, including
   * the page cap and the timeline's "a timeline is read for a party, a deal or
   * a subject" rule. A ZodError raised here maps to 400 in AllExceptionsFilter,
   * so a malformed tool call is refused rather than quietly reinterpreted.
   */
  switch (tool.name) {
    case "crm_list_parties": {
      const query = listPartiesQuerySchema.parse({
        page: args.page ?? 1,
        limit: args.limit ?? 20,
        ...(args.search === undefined ? {} : { search: args.search }),
      });
      result = await services.partyService.listParties(context.orgId, query);
      break;
    }

    case "crm_get_party": {
      const partyId = typeof args.partyId === "string" ? args.partyId.trim() : "";
      if (!partyId) throw new BadRequestException("partyId is required");
      result = await services.partyService.getParty(context.orgId, partyId);
      break;
    }

    case "crm_list_deals": {
      /*
       * `decision.scope`, not the literal string "global" this passed before.
       *
       * "global" is not a member of `DataScope`, so `applyScope` fell through
       * to its exhaustive default and returned sql`false`: this tool answered
       * every agent with an EMPTY LIST, silently, because an empty deals result
       * is indistinguishable from an organisation that has no deals.
       */
      const query = listDealsSchema.parse({
        limit: args.limit ?? 20,
        ...(args.offset === undefined ? {} : { offset: args.offset }),
        ...(args.stage === undefined ? {} : { stage: args.stage }),
        ...(args.assignedToId === undefined ? {} : { assignedToId: args.assignedToId }),
      });
      result = await services.dealsService.listDeals(
        ScopedRead.of(context.orgId, context.userId, decision.scope),
        query,
      );
      break;
    }

    case "crm_get_deal": {
      /*
       * `authorize`, run before this handler, resolves the caller's DataScope
       * and clamps it to a token's ceiling, and `CrmMcpService` promises "the
       * exact same permission resolution via AccessService" as HTTP. Passing
       * anything else throws that promise away.
       */
      const dealId = Number(args.dealId);
      if (!Number.isInteger(dealId) || dealId < 1)
        throw new BadRequestException("Valid dealId is required");
      result = await services.dealsService.getDeal(
        context.orgId,
        context.userId,
        dealId,
        ScopedRead.of(context.orgId, context.userId, decision.scope),
      );
      break;
    }

    case "crm_list_activities": {
      /*
       * The anchor is required, and that is the timeline's own rule rather
       * than one invented here — `timelineQuerySchema` refines on it. Without
       * one the service's anchor falls to `subject_id = ''`, which matches
       * nothing, so an unanchored call returned an empty page that reads as
       * "this deal has no activity". Refusing says what actually happened.
       */
      const query = timelineQuerySchema.parse({
        limit: args.limit ?? 25,
        ...(args.partyId === undefined ? {} : { partyId: args.partyId }),
        ...(args.dealId === undefined ? {} : { dealId: args.dealId }),
        ...(args.kind === undefined ? {} : { kind: args.kind }),
        ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
      });
      result = await services.activitiesService.timeline(context.orgId, query);
      break;
    }

    case "crm_run_report": {
      const source = typeof args.source === "string" ? args.source : "";
      const select = MCP_REPORT_PROJECTIONS.get(source);
      if (!select)
        throw new BadRequestException(
          `Unknown report source '${source}'. Valid sources: ${[...MCP_REPORT_PROJECTIONS.keys()].join(", ")}.`,
        );
      const query = queryDescriptionSchema.parse({
        source,
        select,
        limit: args.limit ?? 50,
      });
      result = await services.reportingService.runAdHoc(
        context.orgId,
        context.userId,
        asQueryDescription(query),
      );
      break;
    }

    default:
      throw new BadRequestException(`Unimplemented tool handler: ${tool.name}`);
  }

  return result;
}
