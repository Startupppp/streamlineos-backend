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
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { DealsCompetitorsService } from "./deals-competitors.service";
import {
  createCompetitorSchema,
  updateCompetitorSchema,
  type CreateCompetitorInput,
  type UpdateCompetitorInput,
} from "./dto/deals.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("crm")
@Controller("deals")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class DealsCompetitorsController {
  constructor(private readonly competitors: DealsCompetitorsService) {}

  @Get(":dealId/competitors")
  @RequirePermission("crm:deals:read")
  list(
    @Param("dealId", ParseIntPipe) dealId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.competitors.list(u.orgId, dealId);
  }

  @Post(":dealId/competitors")
  @HttpCode(201)
  @RequirePermission("crm:deals:update")
  create(
    @Param("dealId", ParseIntPipe) dealId: number,
    @Body(new ZodValidationPipe(createCompetitorSchema)) body: CreateCompetitorInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.competitors.create(u.orgId, dealId, body);
  }

  @Patch(":dealId/competitors/:competitorId")
  @RequirePermission("crm:deals:update")
  update(
    @Param("dealId", ParseIntPipe) dealId: number,
    @Param("competitorId") competitorId: string,
    @Body(new ZodValidationPipe(updateCompetitorSchema)) body: UpdateCompetitorInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.competitors.update(u.orgId, dealId, competitorId, body);
  }

  @Delete(":dealId/competitors/:competitorId")
  @RequirePermission("crm:deals:update")
  remove(
    @Param("dealId", ParseIntPipe) dealId: number,
    @Param("competitorId") competitorId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.competitors.remove(u.orgId, dealId, competitorId);
  }
}
