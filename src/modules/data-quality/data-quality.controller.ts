import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { Validate } from "../../common/validation/validate.decorator";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
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

import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  findingsPageSchema,
  findingDetailSchema,
  findingGroupsSchema,
  healthSchema,
  resolutionsPageSchema,
  assignSchema as assignResponseSchema,
  resolveSchema,
  reverseSchema,
  scanSchema as scanResponseSchema,
} from "./dto/data-quality-response.schemas";

const VIEW = "crm:data-quality:view";
const findingIdParams = z.object({ findingId: z.string().min(1) }).strict();
const resolutionIdParams = z.object({ resolutionId: z.string().min(1) }).strict();

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
  @ResponseSchema(findingsPageSchema)
  @Validate({ query: listFindingsQuerySchema })
  listFindings(
    @Query() query: ListFindingsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.queue.listFindings(u.orgId, query);
  }

  @Get("findings/:findingId")
  @RequirePermission(VIEW)
  @ResponseSchema(findingDetailSchema)
  @Validate({ params: findingIdParams })
  getFinding(@Param("findingId") findingId: string, @CurrentUser() u: CurrentUserContext) {
    return this.queue.getFinding(u.orgId, findingId);
  }

  @Get("groups")
  @RequirePermission(VIEW)
  @ResponseSchema(findingGroupsSchema)
  @Validate({ query: listGroupsQuerySchema })
  listGroups(
    @Query() query: ListGroupsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.queue.listGroups(u.orgId, query);
  }

  @Get("health")
  @RequirePermission(VIEW)
  @ResponseSchema(healthSchema)
  @Validate({ query: healthQuerySchema })
  health(
    @Query() query: HealthQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.queue.health(u.orgId, query);
  }

  @Get("resolutions")
  @RequirePermission(VIEW)
  @ResponseSchema(resolutionsPageSchema)
  @Validate({ query: listResolutionsQuerySchema })
  listResolutions(
    @Query() query: ListResolutionsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.queue.listResolutions(u.orgId, query);
  }

  @Post("assign")
  @Idempotent("crm.data-quality.assign")
  @RequirePermission("crm:data-quality:assign")
  @ResponseSchema(assignResponseSchema)
  @Validate({ body: assignFindingsSchema })
  assign(
    @Body() body: AssignFindingsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.queue.assign(u.orgId, u.userId, body);
  }

  @Post("resolve")
  @Idempotent("crm.data-quality.resolve")
  @RequirePermission("crm:data-quality:resolve")
  @ResponseSchema(resolveSchema)
  @Validate({ body: resolveFindingsSchema })
  resolve(
    @Body() body: ResolveFindingsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.resolution.resolve(u.orgId, u.userId, body);
  }

  @Post("resolutions/:resolutionId/reverse")
  @Idempotent("crm.data-quality.reverse")
  @RequirePermission("crm:data-quality:resolve")
  @ResponseSchema(reverseSchema)
  @Validate({ params: resolutionIdParams, body: reverseResolutionSchema })
  reverse(
    @Param("resolutionId") resolutionId: string,
    @Body() body: ReverseResolutionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.resolution.reverse(u.orgId, u.userId, resolutionId, body);
  }

  @Post("scan")
  @Idempotent("crm.data-quality.scan")
  @RequirePermission("crm:data-quality:resolve")
  @ResponseSchema(scanResponseSchema)
  @Validate({ body: scanSchema })
  scan(
    @Body() body: ScanInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.producers.sweep(u.orgId, body);
  }
}
