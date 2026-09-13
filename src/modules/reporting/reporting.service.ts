import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { crmReportRuns } from "../../db/schema";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AiGatewayService } from "../ai/core/gateway/ai-gateway.service";
import { nlProposalSchema, type NlProposal } from "./nl-proposal.schemas";
import { nlProposalPrompt } from "./nl-proposal.prompt";
import type { CompiledQuery } from "./compiler/compile";
import type { QueryDescription } from "./compiler/query-description";
import { REPORTING_REGISTRY } from "./compiler/registry";
import { toDrizzleSql } from "./compiler/to-drizzle-sql";
import { decideSourceAccess } from "./reporting-source-access";
import { ReportingAuthService } from "./reporting-auth.service";
import { ReportingDefinitionsService } from "./reporting-definitions.service";
import type { RunDefinitionInput } from "./dto/reporting.schemas";

/**
 * Compiling and running report descriptions.
 *
 * Two orderings here are load-bearing and neither is obvious from the call site.
 *
 * **Permission before compilation.** The source's key is checked before
 * `compileQuery` runs, so a caller who may not read parties learns that, rather
 * than learning which fields exist on parties by probing the compiler's error
 * messages. The compiler's refusals name the caller's own strings back at them,
 * which is right for a person debugging their own report and wrong as a reply to
 * somebody enumerating a schema they have no access to.
 *
 * **Compilation before execution, always.** There is no path that executes
 * anything but the output of `compileQuery`. That is what makes the safety
 * argument a property of the module rather than of each method.
 */

/** What a run returns: rows, plus what the columns mean. */
export interface ReportResult {
  readonly columns: CompiledQuery["columns"];
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount: number;
  /** True when the page came back full, so the caller knows to ask for more. */
  readonly truncated: boolean;
}

@Injectable()
export class ReportingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly auth: ReportingAuthService,
    private readonly definitions: ReportingDefinitionsService,
    private readonly aiGateway: AiGatewayService,
  ) {}

  /**
   * The queryable surface, filtered to what this caller may actually run.
   *
   * Filtered rather than annotated. A response listing every source with
   * `canRead: false` beside the ones you are denied is a schema disclosure with
   * a flag on it — it tells a caller that a `parties` source exists, what its
   * fields are called, and therefore what the tenant stores.
   */
  async describeSources(orgId: string, userId: string) {
    const held = await this.auth.heldPermissions(orgId, userId);

    return [...REPORTING_REGISTRY.entries()]
      .filter(([key]) => decideSourceAccess(key, held).allowed)
      .map(([key, source]) => ({
        key,
        label: source.label,
        fields: Object.entries(source.fields).map(([name, field]) => ({
          name,
          label: field.label,
          type: field.type,
        })),
        relations: Object.entries(source.joins ?? {}).map(([name, join]) => ({
          name,
          fields: Object.entries(join.fields).map(([fieldName, field]) => ({
            name: `${name}.${fieldName}`,
            label: field.label,
            type: field.type,
          })),
        })),
      }));
  }

  /**
   * What this description would execute, without executing it.
   *
   * The statement is safe to hand back for the same reason it is safe to store:
   * it contains no literals. This is the endpoint that makes the module's claim
   * checkable by the people who have to trust it — a tenant's security reviewer
   * can send their worst description and read exactly what the database would
   * have been asked, with their own values conspicuously absent from it.
   *
   * It is behind the manage key rather than the view key because the compiled
   * statement names physical tables and columns, which is more than a report
   * reader needs to know.
   */
  async explain(user: CurrentUserContext, query: QueryDescription) {
    await this.auth.assertMayRunSource(user, query.source);
    const compiled = this.auth.compileOrThrow(query, user.orgId, await this.auth.requesterScope(user));

    return {
      source: compiled.source,
      sql: compiled.text,
      /**
       * The count, never the values. The statement is content-free; the
       * parameters are the content, and echoing them into a response body that
       * may be logged or pasted into a ticket would put tenant data where the
       * design took care to keep it out.
       */
      parameterCount: compiled.params.length,
      columns: compiled.columns,
    };
  }

  /**
   * Phase 5 ticket 15. A plain-language question, proposed as a query
   * description — never run.
   *
   * The evaluation gate the ticket's fifth criterion asks for is three
   * layers, each catching what the one before it cannot:
   *  1. The model itself may answer `{ ok: false, reason }` — the schema in
   *     `nl-proposal.schemas.ts` gives it that shape explicitly, so refusing
   *     is a real branch rather than a temptation to fabricate.
   *  2. `assertMayRunSource` — a model that proposed a source or field the
   *     CALLER cannot see fails here, structurally, before the description
   *     is ever shown to them.
   *  3. `explain` — the same compiler a hand-built description goes
   *     through. A hallucinated field name here throws, and this method
   *     turns that into a `{ accepted: false }` the same shape as (1) rather
   *     than a 500 — a reviewer reading "the model's proposal didn't
   *     compile" and "the model said it couldn't answer this" should not
   *     have to tell the two apart from a stack trace.
   *
   * `accepted: true` returns the description and its compile preview —
   * SQL text and column list, never rows — for a person to read before
   * deciding anything. Running it is a SEPARATE call to `explain`'s
   * sibling `run`, made only once a person chooses to; nothing on this
   * path reaches it.
   */
  async proposeFromQuestion(
    user: CurrentUserContext,
    question: string,
  ): Promise<
    | { accepted: true; description: QueryDescription; explanation: string; preview: Awaited<ReturnType<ReportingService["explain"]>> }
    | { accepted: false; reason: string }
  > {
    const sources = await this.describeSources(user.orgId, user.userId);
    if (sources.length === 0) {
      return { accepted: false, reason: "You do not have access to any reportable data source." };
    }

    const prompt = nlProposalPrompt(question, sources);
    const result = await this.aiGateway.invokeStructured<NlProposal>({
      actor: { orgId: user.orgId, userId: user.userId },
      feature: "crm.reporting.nl-propose",
      prompt: { system: prompt.system, user: prompt.user, promptKey: "crm.reporting.nl_propose", promptVersion: 1 },
      schema: nlProposalSchema,
      tier: "standard",
      maxTokens: 1024,
      charge: true,
    });

    if (!result.ok) {
      throw new BadRequestException(
        result.kind === "concurrency_exceeded"
          ? "Too many report questions in flight right now — try again shortly."
          : `Could not reach the model to propose a query: ${result.message}`,
      );
    }

    const proposal = result.data;
    if (!proposal.ok) return { accepted: false, reason: proposal.reason };

    try {
      await this.auth.assertMayRunSource(user, proposal.description.source);
      const preview = await this.explain(user, proposal.description as QueryDescription);
      return {
        accepted: true,
        description: proposal.description as QueryDescription,
        explanation: proposal.explanation,
        preview,
      };
    } catch (error) {
      return {
        accepted: false,
        reason:
          error instanceof ForbiddenException || error instanceof BadRequestException
            ? `The model's proposal didn't hold up: ${error.message}`
            : "The model's proposal didn't hold up against the real data model.",
      };
    }
  }

  async runAdHoc(user: CurrentUserContext, query: QueryDescription) {
    return this.run(user, query, null);
  }

  async runDefinition(
    user: CurrentUserContext,
    reportDefinitionId: string,
    overrides: RunDefinitionInput,
  ) {
    const definition = await this.definitions.getDefinition(user.orgId, reportDefinitionId);

    /**
     * The overrides are merged into the stored description and the result goes
     * through the compiler like anything else — they are not applied to the
     * compiled statement. Patching `LIMIT` into finished SQL is how a query
     * surface acquires its first string concatenation.
     */
    const query: QueryDescription = {
      ...(definition.queryDescription as QueryDescription),
      ...(overrides.limit === undefined ? {} : { limit: overrides.limit }),
      ...(overrides.offset === undefined ? {} : { offset: overrides.offset }),
    };

    return this.run(user, query, reportDefinitionId);
  }

  private async run(
    user: CurrentUserContext,
    query: QueryDescription,
    reportDefinitionId: string | null,
  ): Promise<ReportResult> {
    await this.auth.assertMayRunSource(user, query.source);
    const compiled = this.auth.compileOrThrow(query, user.orgId, await this.auth.requesterScope(user));

    const startedAt = Date.now();
    const rows = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const result = await tx.execute(toDrizzleSql(compiled));
        return [...(result as unknown as Record<string, unknown>[])];
      },
      { orgId: user.orgId },
    );
    const durationMs = Date.now() - startedAt;

    await this.recordRun(user.orgId, user.userId, compiled, reportDefinitionId, rows.length, durationMs);

    return {
      columns: compiled.columns,
      rows,
      rowCount: rows.length,
      /**
       * A full page means there may be more. Said explicitly because the caller
       * cannot tell otherwise, and a report silently showing the first page of a
       * larger answer is the failure the refused-not-clamped limit exists to
       * prevent — it would come straight back if the caller had to guess.
       */
      truncated: rows.length >= query.limit,
    };
  }

  /**
   * The audit row, written after the run rather than before it.
   *
   * After, because the row carries the duration and the row count, and a
   * two-phase write (insert, run, update) would double the cost of every report
   * to record something no reader needs sooner. The trade is that a query killed
   * by a statement timeout leaves no row — acceptable, because that failure is
   * already visible in the error the caller receives and in the database's own
   * logs, and this table exists to answer "what was asked", not "what crashed".
   */
  private async recordRun(
    orgId: string,
    userId: string,
    compiled: CompiledQuery,
    reportDefinitionId: string | null,
    rowCount: number,
    durationMs: number,
  ): Promise<void> {
    await this.db.insert(crmReportRuns).values({
      organizationId: orgId,
      reportDefinitionId,
      sourceKey: compiled.source,
      compiledSql: compiled.text,
      parameterCount: compiled.params.length,
      rowCount,
      durationMs,
      ranByUserId: userId,
    });
  }
}
