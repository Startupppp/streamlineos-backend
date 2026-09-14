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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { CrmTerritoriesService } from "./crm-territories.service";
import {
  territoryCreateSchema,
  territoryListSchema,
  territoryPreviewSchema,
  territoryUpdateSchema,
  type TerritoryCreateInput,
  type TerritoryListInput,
  type TerritoryPreviewInput,
  type TerritoryUpdateInput,
} from "./dto/territories.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema, NoContentResponse } from "../../../common/openapi/zod-operation-contracts";
import {
  territorySchema,
  territoryPreviewSchema as territoryPreviewResponseSchema,
} from "./dto/crm-territories-response.schemas";

const territoryIdParams = z.object({ territoryId: z.coerce.number().int().positive() }).strict();

@RequireModule("crm")
@Controller("crm/territories")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CrmTerritoriesController {
  constructor(private readonly territories: CrmTerritoriesService) {}

  private async loadTerritoryWithDetail(orgId: string, id: number) {
    return this.territories.getOne(orgId, id);
  }

  @Get()
  @RequirePermission("crm:territories:manage")
  @ResponseSchema(z.array(territorySchema))
  @Validate({ query: territoryListSchema })
  list(
    @Query() query: TerritoryListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.territories.list(u.orgId, query.limit);
  }

  @Post("preview")
  @RequirePermission("crm:territories:manage")
  @ResponseSchema(territoryPreviewResponseSchema)
  @Validate({ body: territoryPreviewSchema })
  preview(
    @Body() body: TerritoryPreviewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.territories.preview(u.orgId, body.sample);
  }

  @Post()
  @RequirePermission("crm:territories:manage")
  @HttpCode(201)
  @ResponseSchema(territorySchema)
  @Validate({ body: territoryCreateSchema })
  async create(
    @Body() body: TerritoryCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const created = await this.territories.create(u.orgId, u.userId, body);
    const detail = await this.loadTerritoryWithDetail(u.orgId, created.id);
    if (!detail) throw new NotFoundException("Territory not found");
    return detail;
  }

  @Patch(":territoryId")
  @RequirePermission("crm:territories:manage")
  @ResponseSchema(territorySchema)
  @Validate({ params: territoryIdParams, body: territoryUpdateSchema })
  async update(
    @Param("territoryId", ParseIntPipe) territoryId: number,
    @Body() body: TerritoryUpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const exists = await this.territories.exists(u.orgId, territoryId);
    if (!exists) throw new NotFoundException("Territory not found");
    await this.territories.update(u.orgId, territoryId, body);
    const updated = await this.loadTerritoryWithDetail(u.orgId, territoryId);
    if (!updated) throw new NotFoundException("Territory not found");
    return updated;
  }

  @Delete(":territoryId")
  @HttpCode(204)
  @RequirePermission("crm:territories:manage")
  @NoContentResponse()
  @Validate({ params: territoryIdParams })
  async remove(
    @Param("territoryId", ParseIntPipe) territoryId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const exists = await this.territories.exists(u.orgId, territoryId);
    if (!exists) throw new NotFoundException("Territory not found");
    await this.territories.remove(u.orgId, territoryId);
  }
}
