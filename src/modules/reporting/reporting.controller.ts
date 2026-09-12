import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ReportingService } from "./reporting.service";
import { asQueryDescription } from "./dto/reporting.schemas";
import {
  createDefinitionSchema,
  listQuerySchema,
  runAdHocSchema,
  runDefinitionSchema,
  updateDefinitionSchema,
  type CreateDefinitionInput,
  type ListQuery,
  type RunAdHocInput,
  type RunDefinitionInput,
  type UpdateDefinitionInput,
} from "./dto/reporting.schemas";

/**
 * The reporting surface.
 *
 * Three authorities, and the split is the argument.
 *
 * `view` reads what already exists — the list of saved reports, one report's
 * definition, and the log of what has been run. It is the auditor's key and the
 * reader's key, and holding it lets you see the questions without asking any.
 *
 * `manage` authors. Saving a report is not the same act as reading one: a saved
 * definition is shared, is what other people will run, and is where a badly
 * scoped question becomes an organisational fact. `explain` sits here too,
 * because it returns physical table and column names.
 *
 * `run` executes, and is the one that touches data. It is separate from `manage`
 * so that "may build reports" and "may pull the numbers" can be granted apart —
 * and because running is the only verb here with a cost, both in database time
 * and in what comes back.
 *
 * None of the three is sufficient on its own to read a source. Every run and
 * every save also requires the permission that governs the underlying rows
 * elsewhere in the product — `crm:deals:read` for deals, `party:parties:view`
 * for parties — enforced in the service, because the guard can only check a
 * constant and the source is known only after the body is parsed. See
 * `reporting-source-access.ts`.
 *
 * ## The keys are literals, and must stay literals
 *
 * Every gate below spells its key out rather than referring to a constant. That
 * is deliberate and should not be tidied. `gated-keys-are-catalogued.spec.ts`
 * finds gates by scanning source for the decorator with a quoted argument, and a
 * regex cannot resolve a constant — so a gate written against a constant is one
 * that spec cannot read. It counts how many it has to skip and fails the build
 * when that number grows, precisely so a module cannot quietly opt out.
 *
 * The cost of opting out is the bug that spec exists to catch:
 * `party:divergence:view` was gated on a route, granted by migration 0244, and
 * absent from the catalogue — so it answered for every organisation that existed
 * when the backfill ran and would have 403'd for every one created afterwards.
 * Nothing failed. Ten unreadable gates would be ten more chances at that.
 *
 * The same three keys also exist as named constants in
 * `reporting-source-access.ts`, where they are used by logic rather than by a
 * decorator, and a spec asserts each against the catalogue.
 */

@RequireModule("crm")
@Controller("crm/reporting")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ReportingController {
  constructor(private readonly reporting: ReportingService) {}

  /**
   * What this caller may ask about.
   *
   * Behind `run` rather than `view`, because the answer is the list of sources
   * this caller could actually query — deriving it needs the same decision the
   * run path makes, and a reader who cannot run anything would get an empty list
   * that reads as a bug.
   */
  @Get("sources")
  @RequirePermission("crm:reporting:run")
  sources(@CurrentUser() u: CurrentUserContext) {
    return this.reporting.describeSources(u.orgId, u.userId);
  }

  @Get("definitions")
  @RequirePermission("crm:reporting:view")
  listDefinitions(
    @Query(new ZodValidationPipe(listQuerySchema)) query: ListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reporting.listDefinitions(u.orgId, query);
  }

  @Get("definitions/:reportDefinitionId")
  @RequirePermission("crm:reporting:view")
  getDefinition(
    @Param("reportDefinitionId") reportDefinitionId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reporting.getDefinition(u.orgId, reportDefinitionId);
  }

  @Post("definitions")
  @RequirePermission("crm:reporting:manage")
  createDefinition(
    @Body(new ZodValidationPipe(createDefinitionSchema)) body: CreateDefinitionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reporting.createDefinition(u, body);
  }

  @Patch("definitions/:reportDefinitionId")
  @RequirePermission("crm:reporting:manage")
  updateDefinition(
    @Param("reportDefinitionId") reportDefinitionId: string,
    @Body(new ZodValidationPipe(updateDefinitionSchema)) body: UpdateDefinitionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reporting.updateDefinition(u, reportDefinitionId, body);
  }

  @Delete("definitions/:reportDefinitionId")
  @RequirePermission("crm:reporting:manage")
  deleteDefinition(
    @Param("reportDefinitionId") reportDefinitionId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reporting.deleteDefinition(u.orgId, reportDefinitionId);
  }

  /**
   * Compile a description and return the statement, executing nothing.
   *
   * This endpoint is the module's honesty check, and it exists to be used by
   * people who do not believe the docblocks. Send the most hostile description
   * you can express and read back exactly what the database would have been
   * asked: the values you sent will not be in it.
   */
  @Post("explain")
  @RequirePermission("crm:reporting:manage")
  explain(
    @Body(new ZodValidationPipe(runAdHocSchema)) body: RunAdHocInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reporting.explain(u, asQueryDescription(body.query));
  }

  @Post("run")
  @RequirePermission("crm:reporting:run")
  runAdHoc(
    @Body(new ZodValidationPipe(runAdHocSchema)) body: RunAdHocInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reporting.runAdHoc(u, asQueryDescription(body.query));
  }

  @Post("definitions/:reportDefinitionId/run")
  @RequirePermission("crm:reporting:run")
  runDefinition(
    @Param("reportDefinitionId") reportDefinitionId: string,
    @Body(new ZodValidationPipe(runDefinitionSchema)) body: RunDefinitionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reporting.runDefinition(u, reportDefinitionId, body);
  }

  /**
   * What has been run, and what statement was executed.
   *
   * Behind `view` because it is the audit read, and an auditor should not need
   * the ability to run reports in order to review the ones that were run. The
   * statements it returns carry no tenant values — that is what makes this
   * grantable without also granting a view of the data.
   */
  @Get("runs")
  @RequirePermission("crm:reporting:view")
  listRuns(
    @Query(new ZodValidationPipe(listQuerySchema)) query: ListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reporting.listRuns(u.orgId, query);
  }
}
