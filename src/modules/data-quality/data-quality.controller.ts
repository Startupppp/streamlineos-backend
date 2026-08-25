import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { DataQualityQueueService } from "./data-quality-queue.service";
import { DataQualityResolutionService } from "./data-quality-resolution.service";
import { DataQualityProducersService } from "./data-quality-producers.service";
import {
  assignFindingsSchema,
  healthQuerySchema,
  listFindingsQuerySchema,
  listGroupsQuerySchema,
  listResolutionsQuerySchema,
  resolveFindingsSchema,
  reverseResolutionSchema,
  scanSchema,
  type AssignFindingsInput,
  type HealthQuery,
  type ListFindingsQuery,
  type ListGroupsQuery,
  type ListResolutionsQuery,
  type ResolveFindingsInput,
  type ReverseResolutionInput,
  type ScanInput,
} from "./dto/data-quality.schemas";

const VIEW = "crm:data-quality:view";

/**
 * The data-quality queue.
 *
 * Three authorities, deliberately separate. Reading the queue is what makes a
 * problem visible; assigning is what makes it somebody's; resolving is what
 * changes the dataset. A manager who should see how bad the data is need not be
 * someone who may merge four hundred customer records, and folding those into
 * one key would make the second unavoidable to grant.
 *
 * Sits beside `GET /crm/data-quality`, which is the standing report this queue
 * exists to replace — see the module comment.
 */
@RequireModule("crm")
@Controller("crm/data-quality")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class DataQualityController {
  constructor(
    private readonly queue: DataQualityQueueService,
    private readonly resolution: DataQualityResolutionService,
    private readonly producers: DataQualityProducersService,
  ) {}

  @Get("findings")
  @RequirePermission(VIEW)
  listFindings(
    @Query(new ZodValidationPipe(listFindingsQuerySchema)) query: ListFindingsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.queue.listFindings(u.orgId, query);
  }

  @Get("findings/:findingId")
  @RequirePermission(VIEW)
  getFinding(@Param("findingId") findingId: string, @CurrentUser() u: CurrentUserContext) {
    return this.queue.getFinding(u.orgId, findingId);
  }

  /**
   * The open queue as shapes of problem rather than instances.
   *
   * This is the screen a bulk decision is taken from — it is what turns four
   * hundred rows into one line a person can act on.
   */
  @Get("groups")
  @RequirePermission(VIEW)
  listGroups(
    @Query(new ZodValidationPipe(listGroupsQuerySchema)) query: ListGroupsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.queue.listGroups(u.orgId, query);
  }

  /**
   * How bad the dataset is, and which way it is moving.
   *
   * Behind the view key rather than the resolve key: this is the evidence
   * somebody uses to decide whether the queue needs attention at all, and hiding
   * it behind the ability to act on it would invert the decision it informs.
   */
  @Get("health")
  @RequirePermission(VIEW)
  health(
    @Query(new ZodValidationPipe(healthQuerySchema)) query: HealthQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.queue.health(u.orgId, query);
  }

  /** Every decision taken about this queue, newest first. */
  @Get("resolutions")
  @RequirePermission(VIEW)
  listResolutions(
    @Query(new ZodValidationPipe(listResolutionsQuerySchema)) query: ListResolutionsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.queue.listResolutions(u.orgId, query);
  }

  /** Make it somebody's work, or hand it back. */
  @Post("assign")
  @Idempotent("crm.data-quality.assign")
  @RequirePermission("crm:data-quality:assign")
  assign(
    @Body(new ZodValidationPipe(assignFindingsSchema)) body: AssignFindingsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.queue.assign(u.orgId, u.userId, body);
  }

  /**
   * One decision, however many findings it covers.
   *
   * Deliberately not a per-finding route with a bulk wrapper around it. The
   * selection is the argument, a single row records the decision, and nothing in
   * the response pretends four hundred separate judgements were made.
   */
  @Post("resolve")
  @Idempotent("crm.data-quality.resolve")
  @RequirePermission("crm:data-quality:resolve")
  resolve(
    @Body(new ZodValidationPipe(resolveFindingsSchema)) body: ResolveFindingsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.resolution.resolve(u.orgId, u.userId, body);
  }

  /**
   * Take one decision back, where its reversibility class allows it.
   *
   * Same key as making it: undoing a bulk merge and making one are the same
   * authority over the same records, and splitting them would leave someone able
   * to break the dataset but not repair it.
   */
  @Post("resolutions/:resolutionId/reverse")
  @Idempotent("crm.data-quality.reverse")
  @RequirePermission("crm:data-quality:resolve")
  reverse(
    @Param("resolutionId") resolutionId: string,
    @Body(new ZodValidationPipe(reverseResolutionSchema)) body: ReverseResolutionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.resolution.reverse(u.orgId, u.userId, resolutionId, body);
  }

  /**
   * Run the producers now.
   *
   * Behind the resolve key rather than the view key: a sweep writes work for the
   * whole organisation and reads a bounded slice of every party, which is not
   * something a read-only audience should be able to schedule at will.
   */
  @Post("scan")
  @Idempotent("crm.data-quality.scan")
  @RequirePermission("crm:data-quality:resolve")
  scan(
    @Body(new ZodValidationPipe(scanSchema)) body: ScanInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.producers.sweep(u.orgId, body);
  }
}
