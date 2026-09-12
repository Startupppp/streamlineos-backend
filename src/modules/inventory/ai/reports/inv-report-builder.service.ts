import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { readEvidence } from "../lib/inv-ai-read-evidence";
import { AccessService } from "../../../access/access.service";
import { AiGatewayService } from "../../../ai/core/gateway/ai-gateway.service";
import type { AiUsageMeta } from "../../../ai/core/gateway/ai-gateway.types";
import { toCsv } from "../../import-export/csv.util";
import { InvReportsService } from "../../reports/inv-reports.service";
import { InvReportsExtendedService } from "../../reports/inv-reports-extended.service";
import { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import { INV_AI_CONTRACT_VERSION, type InvAiProvenance } from "../dto/inv-ai-contract";
import {
  INV_REPORT_CATALOG,
  describeInvReports,
  readPath,
  type InvReportCell,
  type InvReportColumn,
} from "./inv-report-catalog";
import { planReportFromQuestion } from "./inv-report-planner";
import {
  invReportSpecSchema,
  type InvReportAskInput,
  type InvReportSpec,
} from "./dto/inv-report-spec.schemas";

const FEATURE_KEY = "inv.report-builder" as const;
const PROMPT_KEY = "inv.report-builder" as const;
const PROMPT_VERSION = 1 as const;

/**
 * How many rows a preview shows. The model does not get a say — `limit` is not
 * a field in any filter schema — because "how much of the organisation's data
 * comes back" is a decision about cost and disclosure, not about the question.
 */
export const REPORT_PREVIEW_CAP = 25;

/**
 * How many rows an export may carry. Larger than a preview because a file is
 * what somebody wanted, still bounded because an unbounded export is a memory
 * limit waiting for a large tenant.
 */
export const REPORT_EXPORT_CAP = 100;

/**
 * F5 — natural language in, an allowlisted report config out, rows the asker's
 * own permissions filtered.
 *
 * ## Where the safety actually is
 *
 * Not in this file. It is in `dto/inv-report-spec.schemas.ts`, which gives the
 * model no field that could carry SQL, and in the reports module's services,
 * which already bind the asker's warehouse scope into the predicate of every
 * query they run. This service is the wiring between the two, and its job is to
 * make sure nothing slips between them:
 *
 *   * the spec is **parsed**, never trusted, on every path including the export
 *     path where the client hands one back;
 *   * a warehouse the model proposed is **checked against the asker's scope**
 *     and dropped when it is not theirs — and the drop is reported, so a
 *     narrowed report never silently looks like a complete one;
 *   * a warehouse the *asker* named is checked too, and answered 404 rather than
 *     403, because a 403 on somebody else's warehouse confirms it exists;
 *   * the report's own permission is checked **before it runs**, so choosing a
 *     report is not a way to read one you could not open directly;
 *   * page, row cap, sort and columns are the server's, on both paths.
 *
 * ## Two ways a warehouse arrives, two answers
 *
 * A warehouse the **asker** named is a claim by a principal: if it is not
 * theirs, the request is answered 404 and nothing runs. A warehouse the
 * **model** proposed is not a claim by anybody — it is a guess from a sentence.
 * Refusing the whole request because a model invented a plausible id would
 * punish the user for something they did not do, so it is stripped, the report
 * runs at the scope the asker actually holds, and the response says which filter
 * was removed and why.
 */

export type InvReportStatus = "ok" | "not_permitted";

export interface InvReportStrippedFilter {
  field: string;
  reason: string;
}

export interface InvReportPreview {
  status: InvReportStatus;
  question: string;
  /** The config that ran, after scoping. The client hands this back to export. */
  spec: InvReportSpec;
  label: string;
  plannedBy: "model" | "deterministic";
  columns: Array<{ key: string; label: string; numeric: boolean }>;
  rows: Array<Record<string, InvReportCell>>;
  rowCount: number;
  /** Rows matching before the preview cap, when the report reports one. */
  total: number | null;
  /** True when the preview is a sample of a larger result. */
  truncated: boolean;
  /** Filters removed because they named something the asker cannot see. */
  stripped: InvReportStrippedFilter[];
  /** Set on `not_permitted`: the key the chosen report costs. */
  requiredPermission: string | null;
  /** Whether the asker holds the keys the export path would demand. */
  canExport: boolean;
  provenance: InvAiProvenance | null;
  aiUsage?: AiUsageMeta;
  generatedAt: string;
}

export interface InvReportExport {
  filename: string;
  csv: string;
  rowCount: number;
}

/**
 * The planning rules.
 *
 * The prompt contains the question and the static catalogue and **nothing
 * retrieved** — no rows, no notes, no names. That is what makes prompt injection
 * inert here rather than merely unlikely: text from the database is not in the
 * context that decides what to read, so it cannot change the decision no matter
 * what it says.
 */
const SYSTEM_PROMPT = [
  "You turn a question about inventory into a report configuration.",
  "Reply with exactly one report id from the list and a filters object for that report.",
  "RULES:",
  "1. The report id must be one of the listed ids, spelled exactly. Anything else is discarded.",
  "2. The filters object may contain only the fields listed for the report you chose. A field belonging to another report is rejected and the whole configuration is discarded.",
  "3. You do not write SQL, table names, column names, sort orders, page numbers or row limits. They are not fields and the server decides them.",
  "4. Omit a filter you are not confident about. A default window is better than an invented one.",
  "5. Dates are YYYY-MM-DD. Numbers are plain integers.",
].join("\n");

function buildUserPrompt(question: string): string {
  return ["Available reports:", describeInvReports(), "", `Question: ${question}`].join("\n");
}

@Injectable()
export class InvReportBuilderService {
  constructor(
    /**
     * Injected so `ask` can open its own short tenant transactions: the route is
     * `@NoTenantTransaction()` and the provider call sits in the MIDDLE of this
     * service's work, so there are two of them. Nothing here queries through
     * `db` directly — `DRIZZLE` is the tenant-aware proxy, so the report
     * services and `AccessService` pick the transaction up through their own
     * `this.db`.
     */
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
    private readonly access: AccessService,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly reports: InvReportsService,
    private readonly extended: InvReportsExtendedService,
  ) {}

  async ask(user: CurrentUserContext, input: InvReportAskInput): Promise<InvReportPreview> {
    const { orgId, userId } = user;
    const generatedAt = new Date().toISOString();

    /*
     * Transaction one of two. The asker's own warehouse, checked before
     * anything else happens: outside their scope this is 404 and the request
     * ends here — no model call, no report, and no confirmation that the
     * warehouse exists. It gets a short tenant transaction of its own because
     * the route is `@NoTenantTransaction()` and the model call below must not be
     * awaited with a pooled connection idle in transaction.
     *
     * Hoisted to a local so the narrowing survives into the callback: TypeScript
     * does not carry a property narrowing across a closure boundary.
     */
    const askerWarehouseId = input.warehouseId;
    if (askerWarehouseId !== undefined) {
      await readEvidence(this.db, orgId, () =>
        this.warehouseScope.assertWarehouseVisible(orgId, userId, askerWarehouseId),
      );
    }

    const fallback = planReportFromQuestion(input.question);
    // The provider round trip, and the reason for the split. It sits in the
    // MIDDLE of this method's work rather than at the end, so there is a short
    // transaction on each side of it and none across it.
    const { spec: chosen, plannedBy, aiUsage, correlationId, model } = await this.choose(
      user,
      input.question,
      fallback,
    );

    /*
     * Transaction two of two, opened AFTER the provider call has returned. It
     * carries everything that is left: the scope resolution that brings the
     * model's spec inside the asker's warehouses, both permission checks, and
     * the report run itself. One transaction rather than four so the view check
     * and the rows it guards cannot be answered from two different snapshots.
     */
    return readEvidence(this.db, orgId, async () => {
      const { spec, stripped } = await this.scopeSpec(user, chosen, askerWarehouseId);
      const definition = INV_REPORT_CATALOG[spec.report];

      const provenance: InvAiProvenance | null =
        plannedBy === "model" && model !== null && correlationId !== null
          ? {
              contractVersion: INV_AI_CONTRACT_VERSION,
              promptKey: PROMPT_KEY,
              promptVersion: PROMPT_VERSION,
              model,
              correlationId,
            }
          : null;

      const base = {
        question: input.question,
        spec,
        label: definition.label,
        plannedBy,
        columns: toColumnHeaders(definition.columns),
        stripped,
        provenance,
        generatedAt,
        ...(aiUsage ? { aiUsage } : {}),
      };

      // The report's own key, checked before it runs. Naming a report is not a way
      // to read one whose screen you cannot open — the valuation report is the
      // case that makes this concrete, since it costs `inventory:valuation:read`
      // and the other five do not.
      if (!(await this.access.holds(user, definition.viewPermission))) {
        return {
          ...base,
          status: "not_permitted",
          rows: [],
          rowCount: 0,
          total: null,
          truncated: false,
          requiredPermission: definition.viewPermission,
          canExport: false,
        };
      }

      const { items, total } = await definition.run(
        { orgId, userId, page: 1, limit: REPORT_PREVIEW_CAP, reports: this.reports, extended: this.extended },
        spec,
      );

      const rows = items.map((item) => projectRow(item, definition.columns));

      return {
        ...base,
        status: "ok",
        rows,
        rowCount: rows.length,
        total,
        truncated: total !== null ? total > rows.length : rows.length === REPORT_PREVIEW_CAP,
        requiredPermission: null,
        canExport: await this.access.holds(user, definition.exportPermission),
      };
    });
  }

  /**
   * Take the file.
   *
   * No question and no model call, so no credits: this is the "I looked at the
   * preview and want it as a file" path, and re-deriving the spec from the
   * question would let the same words produce a different report the second
   * time. The spec the client hands back is data it holds, never a capability it
   * was granted — so it is re-parsed, re-scoped and re-permissioned here exactly
   * as if it had just arrived from the model.
   *
   * `ForbiddenException` rather than a status, and that difference is
   * deliberate: on the ask path a report the caller cannot read was the model's
   * choice and reporting it is the honest answer, whereas here the caller named
   * it themselves and is being told no.
   */
  async export(user: CurrentUserContext, rawSpec: unknown): Promise<InvReportExport> {
    const { orgId, userId } = user;
    const parsed = invReportSpecSchema.parse(rawSpec);
    const { spec } = await this.scopeSpec(user, parsed, undefined);
    const definition = INV_REPORT_CATALOG[spec.report];

    for (const key of [definition.viewPermission, definition.exportPermission]) {
      if (!(await this.access.holds(user, key))) {
        throw new ForbiddenException(`Exporting this report requires ${key}`);
      }
    }

    const { items } = await definition.run(
      { orgId, userId, page: 1, limit: REPORT_EXPORT_CAP, reports: this.reports, extended: this.extended },
      spec,
    );

    const headers = definition.columns.map((column) => column.label);
    const rows = items.map((item) => {
      const row: Record<string, unknown> = {};
      for (const column of definition.columns) row[column.label] = readPath(item, column.path);
      return row;
    });

    return {
      filename: `inventory-${spec.report.replace(/_/g, "-")}-${new Date().toISOString().slice(0, 10)}.csv`,
      // Reused rather than re-written: `toCsv` already neutralises a leading
      // `=`, `+`, `-` or `@` so a product name cannot become a spreadsheet
      // formula. A second escaper here would be a second chance to forget that.
      csv: toCsv(headers, rows),
      rowCount: rows.length,
    };
  }

  /**
   * Let the model choose, but never at the cost of an answer.
   *
   * The deterministic plan is computed first and is what runs if the call fails
   * or the output does not validate. The model's contribution is therefore a
   * choice among allowlisted reports, and its absence costs relevance rather
   * than availability.
   */
  private async choose(
    user: CurrentUserContext,
    question: string,
    fallback: InvReportSpec,
  ): Promise<{
    spec: InvReportSpec;
    plannedBy: "model" | "deterministic";
    aiUsage?: AiUsageMeta;
    correlationId: string | null;
    model: string | null;
  }> {
    const result = await this.gateway.invokeStructuredWithUsage({
      actor: { orgId: user.orgId, userId: user.userId },
      feature: FEATURE_KEY,
      tier: "fast",
      maxTokens: 256,
      charge: true,
      redact: false,
      schema: invReportSpecSchema,
      prompt: {
        system: SYSTEM_PROMPT,
        user: buildUserPrompt(question),
        promptKey: PROMPT_KEY,
        promptVersion: PROMPT_VERSION,
      },
    });

    if (!result.ok) {
      return { spec: fallback, plannedBy: "deterministic", correlationId: null, model: null };
    }

    return {
      // Parsed again on the way out of the gateway. The gateway already applied
      // the schema, so this is belt and braces — but it is the belt that
      // survives somebody loosening the call site, and it is cheap.
      spec: invReportSpecSchema.parse(result.data),
      plannedBy: "model",
      aiUsage: result.aiUsage,
      correlationId: result.correlationId,
      model: result.aiUsage.model,
    };
  }

  /**
   * Bring a spec inside the asker's own warehouse scope.
   *
   * The report services apply the scope predicate themselves, so a stray filter
   * cannot widen the result — but it can *narrow* it to a site the asker cannot
   * see, which returns zero rows and reads as "there is nothing there" rather
   * than as "that is not yours". Dropping the filter and saying so is the honest
   * answer, and the drop is what F5 asks for.
   */
  private async scopeSpec(
    user: CurrentUserContext,
    spec: InvReportSpec,
    askerWarehouseId: number | undefined,
  ): Promise<{ spec: InvReportSpec; stripped: InvReportStrippedFilter[] }> {
    const definition = INV_REPORT_CATALOG[spec.report];
    if (!definition.takesWarehouse) {
      // The report has no warehouse filter. An asker who pinned one is not
      // ignored silently — the report simply is not per-site, and saying so
      // beats returning an org-wide table under a site heading.
      return {
        spec,
        stripped:
          askerWarehouseId === undefined
            ? []
            : [
                {
                  field: "warehouseId",
                  reason: `The ${definition.label.toLowerCase()} report is not filtered by warehouse.`,
                },
              ],
      };
    }

    // Destructured rather than spread-and-overwritten. Spreading the original
    // filters and conditionally adding `warehouseId` back leaves the stripped
    // id in place whenever the strip happens — the filter is reported as removed
    // and still applied, which is the worst of both.
    const { warehouseId: proposedWarehouseId, ...otherFilters } = spec.filters as {
      warehouseId?: number;
    } & Record<string, unknown>;
    const stripped: InvReportStrippedFilter[] = [];
    const scope = await this.warehouseScope.resolve(user.orgId, user.userId);

    let warehouseId = proposedWarehouseId;
    if (warehouseId !== undefined && scope !== null && !scope.includes(warehouseId)) {
      // Proposed by the model, not by the asker — see the class comment for why
      // this is stripped rather than refused.
      stripped.push({
        field: "warehouseId",
        reason:
          "The suggested warehouse is outside your access, so the report was run across the warehouses you are assigned to.",
      });
      warehouseId = undefined;
    }

    // The asker's own choice wins over the model's. It was checked against their
    // scope before any of this ran.
    if (askerWarehouseId !== undefined) warehouseId = askerWarehouseId;

    return {
      // Re-parsed rather than assembled and trusted. The scoping above rebuilds
      // an object, and an object this file assembled has not been through the
      // union — so it goes through it, and a scoping bug becomes a validation
      // error rather than a query.
      spec: invReportSpecSchema.parse({
        report: spec.report,
        filters: { ...otherFilters, ...(warehouseId === undefined ? {} : { warehouseId }) },
      }),
      stripped,
    };
  }
}

function toColumnHeaders(columns: readonly InvReportColumn[]) {
  return columns.map((column) => ({
    key: column.path,
    label: column.label,
    numeric: column.numeric === true,
  }));
}

function projectRow(
  item: unknown,
  columns: readonly InvReportColumn[],
): Record<string, InvReportCell> {
  const row: Record<string, InvReportCell> = {};
  for (const column of columns) row[column.path] = readPath(item, column.path);
  return row;
}
