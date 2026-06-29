import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { CrmTerritoriesService } from "./crm-territories.service";
import {
  territoryCreateSchema,
  territoryListSchema,
  territoryUpdateSchema,
  type TerritoryCreateInput,
  type TerritoryListInput,
  type TerritoryUpdateInput,
} from "./dto/territories.schemas";

@Controller("crm/territories")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CrmTerritoriesController {
  constructor(private readonly territories: CrmTerritoriesService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(territoryListSchema)) query: TerritoryListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.territories.list(u.orgId, query.limit);
  }

  @Post()
  @RequirePermission("crm:territories:manage")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(territoryCreateSchema)) body: TerritoryCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.territories.create(u.orgId, u.userId, body);
  }

  @Patch(":territoryId")
  @RequirePermission("crm:territories:manage")
  async update(
    @Param("territoryId", ParseIntPipe) territoryId: number,
    @Body(new ZodValidationPipe(territoryUpdateSchema)) body: TerritoryUpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const exists = await this.territories.exists(u.orgId, territoryId);
    if (!exists) throw new NotFoundException("Territory not found");
    return this.territories.update(u.orgId, territoryId, body);
  }

  @Delete(":territoryId")
  @RequirePermission("crm:territories:manage")
  async remove(
    @Param("territoryId", ParseIntPipe) territoryId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const exists = await this.territories.exists(u.orgId, territoryId);
    if (!exists) throw new NotFoundException("Territory not found");
    return this.territories.remove(u.orgId, territoryId);
  }
}
