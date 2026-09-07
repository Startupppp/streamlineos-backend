import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

import { HrSafetyService } from "./hr-safety.service";
import { AccessService } from "../../access/access.service";
import {
  createIncidentSchema,
  updateIncidentSchema,
  listIncidentsSchema,
  checkinSchema,
  wellnessTrendSchema,
  type CreateIncidentInput,
  type UpdateIncidentInput,
  type ListIncidentsInput,
  type CheckinInput,
  type WellnessTrendInput,
} from "./dto/hr-safety.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  hrSafetyIncidentListSchema,
  hrSafetyIncidentSchema,
  hrWellnessCheckinSchema,
  wellnessTrendListSchema,
  burnoutFlagListSchema,
  wellnessPulseSchema,
} from "./dto/cases-response.schemas";

const incidentIdParams = z.object({ incidentId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/safety")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrSafetyController {
  constructor(
    private readonly safety: HrSafetyService,
    private readonly access: AccessService,
  ) {}

  @Get("incidents")
  @ResponseSchema(hrSafetyIncidentListSchema)
  @RequirePermission("hr:safety:view")
  @Validate({ query: listIncidentsSchema })
  listIncidents(
    @CurrentUser() user: CurrentUserContext,
    @Query() query: ListIncidentsInput,
  ) {
    return this.safety.listIncidents(user.orgId, query);
  }

  @Get("incidents/:incidentId")
  @ResponseSchema(hrSafetyIncidentSchema)
  @RequirePermission("hr:safety:view")
  @Validate({ params: incidentIdParams })
  async getIncident(
    @CurrentUser() user: CurrentUserContext,
    @Param("incidentId", ParseIntPipe) incidentId: number,
  ) {
    const hasSensitive = await this.canSensitive(user);
    return this.safety.getIncidentById(user.orgId, incidentId, hasSensitive);
  }

  @Post("incidents")
  @ResponseSchema(hrSafetyIncidentSchema)
  @HttpCode(201)
  @RequirePermission("hr:safety:manage")
  @Validate({ body: createIncidentSchema })
  createIncident(
    @CurrentUser() user: CurrentUserContext,
    @Body() body: CreateIncidentInput,
    @Req() req: Request,
  ) {
    return this.safety.createIncident(user.orgId, user.userId, body, req.ip);
  }

  @Patch("incidents/:incidentId")
  @ResponseSchema(hrSafetyIncidentSchema)
  @RequirePermission("hr:safety:manage")
  @Validate({ params: incidentIdParams, body: updateIncidentSchema })
  async updateIncident(
    @CurrentUser() user: CurrentUserContext,
    @Param("incidentId", ParseIntPipe) incidentId: number,
    @Body() body: UpdateIncidentInput,
    @Req() req: Request,
  ) {
    const hasSensitive = await this.canSensitive(user);
    return this.safety.updateIncident(user.orgId, incidentId, user.userId, hasSensitive, body, req.ip);
  }

  @Delete("incidents/:incidentId")
  @NoContentResponse()
  @RequirePermission("hr:safety:manage")
  @HttpCode(204)
  @Validate({ params: incidentIdParams })
  async deleteIncident(
    @CurrentUser() user: CurrentUserContext,
    @Param("incidentId", ParseIntPipe) incidentId: number,
  ) {
    await this.safety.deleteIncident(user.orgId, incidentId, user.userId);
  }

  @Post("wellness/checkin")
  @ResponseSchema(hrWellnessCheckinSchema)
  @RequirePermission("hr:safety:view")
  @Validate({ body: checkinSchema })
  checkin(
    @CurrentUser() user: CurrentUserContext,
    @Body() body: CheckinInput,
  ) {
    return this.safety.upsertCheckin(user, body);
  }

  @Get("wellness/my")
  @ResponseSchema(z.array(hrWellnessCheckinSchema))
  @RequirePermission("hr:safety:view")
  myCheckins(
    @CurrentUser() user: CurrentUserContext,
    @Query("fromDate") fromDate?: string,
    @Query("toDate") toDate?: string,
  ) {
    return this.safety.myCheckins(user, fromDate, toDate);
  }

  @Get("wellness/trend")
  @ResponseSchema(wellnessTrendListSchema)
  @RequirePermission("hr:safety:manage")
  @Validate({ query: wellnessTrendSchema })
  orgTrend(
    @CurrentUser() user: CurrentUserContext,
    @Query() query: WellnessTrendInput,
  ) {
    return this.safety.orgWellnessTrend(user.orgId, query);
  }

  @Get("wellness/burnout")
  @ResponseSchema(burnoutFlagListSchema)
  @RequirePermission("hr:safety:manage")
  burnoutFlags(@CurrentUser() user: CurrentUserContext) {
    return this.safety.burnoutFlags(user.orgId);
  }

  /** K-anonymized 7-day wellness pulse for ops dashboards. */
  @Get("wellness/pulse")
  @ResponseSchema(wellnessPulseSchema)
  @RequirePermission("hr:safety:manage")
  wellnessPulse(@CurrentUser() user: CurrentUserContext) {
    return this.safety.wellnessPulse(user.orgId);
  }

  private async canSensitive(user: CurrentUserContext): Promise<boolean> {
    if (user.isOrgOwner) return true;
    const perms = await this.access.resolveUserPermissions(user.orgId, user.userId);
    return perms.has("hr:sensitive:view");
  }
}
