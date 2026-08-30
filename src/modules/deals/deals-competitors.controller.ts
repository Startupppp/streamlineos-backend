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
import { DealsCompetitorsService } from "./deals-competitors.service";
import {
  createCompetitorSchema,
  updateCompetitorSchema,
  type CreateCompetitorInput,
  type UpdateCompetitorInput,
} from "./dto/deals.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";

const dealIdParams = z.object({ dealId: z.coerce.number().int().positive() }).strict();
const dealIdcompetitorIdParams = z.object({ dealId: z.coerce.number().int().positive(), competitorId: z.string().min(1) }).strict();

@RequireModule("crm")
@Controller("deals")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class DealsCompetitorsController {
  constructor(private readonly competitors: DealsCompetitorsService) {}

  @Get(":dealId/competitors")
  @RequirePermission("crm:deals:read")
  @Validate({ params: dealIdParams })
  list(
    @Param("dealId", ParseIntPipe) dealId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.competitors.list(u.orgId, dealId);
  }

  @Post(":dealId/competitors")
  @HttpCode(201)
  @RequirePermission("crm:deals:update")
  @Validate({ params: dealIdParams, body: createCompetitorSchema })
  create(
    @Param("dealId", ParseIntPipe) dealId: number,
    @Body() body: CreateCompetitorInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.competitors.create(u.orgId, dealId, body);
  }

  @Patch(":dealId/competitors/:competitorId")
  @RequirePermission("crm:deals:update")
  @Validate({ params: dealIdcompetitorIdParams, body: updateCompetitorSchema })
  update(
    @Param("dealId", ParseIntPipe) dealId: number,
    @Param("competitorId") competitorId: string,
    @Body() body: UpdateCompetitorInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.competitors.update(u.orgId, dealId, competitorId, body);
  }

  @Delete(":dealId/competitors/:competitorId")
  @HttpCode(204)
  @RequirePermission("crm:deals:update")
  @Validate({ params: dealIdcompetitorIdParams })
  async remove(
    @Param("dealId", ParseIntPipe) dealId: number,
    @Param("competitorId") competitorId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.competitors.remove(u.orgId, dealId, competitorId);
  }
}
