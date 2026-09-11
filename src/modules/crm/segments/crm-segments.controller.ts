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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CrmSegmentsService } from "./crm-segments.service";
import {
  createSegmentSchema,
  listSegmentsQuerySchema,
  previewSegmentSchema,
  segmentMembersQuerySchema,
  updateSegmentSchema,
  type CreateSegmentInput,
  type ListSegmentsQuery,
  type PreviewSegmentInput,
  type SegmentMembersQuery,
  type UpdateSegmentInput,
} from "./dto/crm-segments.schemas";

/**
 * The segments surface.
 *
 * Two authorities, not three, and the difference from reporting is deliberate.
 * Reporting splits `view` / `manage` / `run` because running a report has a cost
 * — arbitrary projections, grouping, a thousand rows — so "may build reports"
 * and "may pull the numbers" are worth granting apart. A segment cannot be
 * expensive in that way: its shape is fixed by this module, its sample is capped
 * at a hundred rows and its count is one aggregate. Evaluating one is what
 * *reading* a segment means, so a third key would gate an operation nobody can
 * usefully be denied while still being shown the segment.
 *
 * `view` reads the list, one segment, and who is in it. `manage` authors.
 *
 * Neither is sufficient on its own to reach the rows. Every read that touches
 * data also requires the permission that governs those rows elsewhere in the
 * product — `party:parties:view` for parties — enforced in the service, because
 * a guard can only check a constant and the source is known only after the body
 * or the stored row is read. Without that, a segment would be the way to count
 * the customers whose own screen refuses you. See `segment-query.ts`.
 *
 * ## The keys are literals, and must stay literals
 *
 * Every gate below spells its key out rather than referring to a constant, and
 * that should not be tidied. `gated-keys-are-catalogued.spec.ts` finds gates by
 * scanning source for the decorator with a quoted argument; a regex cannot
 * resolve a constant, so a gate written against one is a gate that spec cannot
 * read. The same keys exist as named constants in `segment-query.ts`, where they
 * are used by logic rather than by a decorator.
 */

@RequireModule("crm")
@Controller("crm/segments")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CrmSegmentsController {
  constructor(private readonly segments: CrmSegmentsService) {}

  /**
   * What a criterion may be written about.
   *
   * Already filtered to the sources this caller could evaluate, so a builder
   * never offers a field that will 403 on save. Behind `view` rather than
   * `manage` because the read side needs it too — a member row's columns are
   * labelled from this.
   */
  @Get("sources")
  @RequirePermission("crm:segments:view")
  sources(@CurrentUser() u: CurrentUserContext) {
    return this.segments.describeSources(u.orgId, u.userId);
  }

  @Get()
  @RequirePermission("crm:segments:view")
  list(
    @Query(new ZodValidationPipe(listSegmentsQuerySchema)) query: ListSegmentsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.segments.listSegments(u.orgId, query);
  }

  /**
   * How many rows criteria match, before anybody names them.
   *
   * A POST because a criteria tree does not fit in a query string, and still a
   * read: it stores nothing and returns a count. Behind `view` — it reads no
   * more than opening a saved segment does, and requiring `manage` would mean
   * somebody able to read every segment could not check a filter before asking
   * for one.
   */
  @Post("preview")
  @RequirePermission("crm:segments:view")
  preview(
    @Body(new ZodValidationPipe(previewSegmentSchema)) body: PreviewSegmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.segments.preview(u.orgId, u.userId, body);
  }

  @Get(":segmentId")
  @RequirePermission("crm:segments:view")
  get(@Param("segmentId") segmentId: string, @CurrentUser() u: CurrentUserContext) {
    return this.segments.getSegment(u.orgId, segmentId);
  }

  /**
   * Who is in the segment, evaluated now.
   *
   * A GET because it is a read of a saved thing, and it takes no offset: no
   * registry source publishes a row identifier, so there is no unique ordering
   * to page on and an offset would repeat and skip rows between pages. The
   * response carries a bounded sample and the exact total beside it.
   */
  @Get(":segmentId/members")
  @RequirePermission("crm:segments:view")
  members(
    @Param("segmentId") segmentId: string,
    @Query(new ZodValidationPipe(segmentMembersQuerySchema)) query: SegmentMembersQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.segments.members(u.orgId, u.userId, segmentId, query.limit);
  }

  @Post()
  @RequirePermission("crm:segments:manage")
  create(
    @Body(new ZodValidationPipe(createSegmentSchema)) body: CreateSegmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.segments.createSegment(u.orgId, u.userId, body);
  }

  @Patch(":segmentId")
  @RequirePermission("crm:segments:manage")
  update(
    @Param("segmentId") segmentId: string,
    @Body(new ZodValidationPipe(updateSegmentSchema)) body: UpdateSegmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.segments.updateSegment(u.orgId, u.userId, segmentId, body);
  }

  @Delete(":segmentId")
  @RequirePermission("crm:segments:manage")
  remove(@Param("segmentId") segmentId: string, @CurrentUser() u: CurrentUserContext) {
    return this.segments.deleteSegment(u.orgId, segmentId);
  }
}
