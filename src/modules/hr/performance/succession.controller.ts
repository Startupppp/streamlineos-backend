import { Controller, Get, HttpCode, Post, Patch, Delete, Body, Param, ParseIntPipe, Query, UseGuards } from "@nestjs/common";
import { SuccessionService } from "./succession.service";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";

import {
  createSuccessionPlanSchema,
  updateSuccessionPlanSchema,
  successionListSchema,
  type CreateSuccessionPlanInput,
  type UpdateSuccessionPlanInput,
  type SuccessionListInput,
} from "./dto/succession.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema, NoContentResponse } from "../../../common/openapi/zod-operation-contracts"
import { listSuccessionPlansResponseSchema, createSuccessionPlanResponseSchema, updateSuccessionPlanResponseSchema } from "./dto/succession-response.schemas"

const successionIdParams = z.object({ successionId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/succession")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class SuccessionController {
  constructor(private readonly successionService: SuccessionService) {}

  @ResponseSchema(listSuccessionPlansResponseSchema)
  @Get()
  @RequirePermission("hr:succession:view")
  @Validate({ query: successionListSchema })
  list(
    @CurrentUser() user: CurrentUserContext,
    @Query() query: SuccessionListInput,
  ) {
    return this.successionService.list(user.orgId, query);
  }

  @ResponseSchema(createSuccessionPlanResponseSchema)
  @Post()
  @HttpCode(201)
  @RequirePermission("hr:succession:manage")
  @Validate({ body: createSuccessionPlanSchema })
  create(
    @CurrentUser() user: CurrentUserContext,
    @Body() body: CreateSuccessionPlanInput,
  ) {
    return this.successionService.create(user.orgId, user.userId, body);
  }

  @ResponseSchema(updateSuccessionPlanResponseSchema)
  @Patch(":successionId")
  @RequirePermission("hr:succession:manage")
  @Validate({ params: successionIdParams, body: updateSuccessionPlanSchema })
  update(
    @CurrentUser() user: CurrentUserContext,
    @Param("successionId", ParseIntPipe) successionId: number,
    @Body() body: UpdateSuccessionPlanInput,
  ) {
    return this.successionService.update(user.orgId, successionId, body);
  }

  @NoContentResponse()
  @Delete(":successionId")
  @HttpCode(204)
  @RequirePermission("hr:succession:manage")
  @Validate({ params: successionIdParams })
  async remove(@CurrentUser() user: CurrentUserContext, @Param("successionId", ParseIntPipe) successionId: number) {
    await this.successionService.remove(user.orgId, successionId);
  }
}
