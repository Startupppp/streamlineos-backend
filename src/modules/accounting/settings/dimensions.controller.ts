import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { DimensionsService } from "./dimensions.service";
import {
  createDimensionSchema,
  updateDimensionSchema,
  createDimensionValueSchema,
  updateDimensionValueSchema,
  type CreateDimensionInput,
  type UpdateDimensionInput,
  type CreateDimensionValueInput,
  type UpdateDimensionValueInput,
} from "./dto/dimensions.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const dimensionIdParams = z.object({ dimensionId: z.coerce.number().int().positive() }).strict();
const dimensionIdvalueIdParams = z.object({ dimensionId: z.coerce.number().int().positive(), valueId: z.coerce.number().int().positive() }).strict();

@RequireModule("accounting")
@Controller("accounting/dimensions")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class DimensionsController {
  constructor(private readonly svc: DimensionsService) {}

  @Get()
  @RequirePermission("accounting:dimensions:read")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.svc.listDimensions(u.orgId);
  }

  @Post()
  @RequirePermission("accounting:dimensions:manage")
  @Validate({ body: createDimensionSchema })
  create(
    @Body() body: CreateDimensionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createDimension(u, body);
  }

  @Patch(":dimensionId")
  @RequirePermission("accounting:dimensions:manage")
  @Validate({ params: dimensionIdParams, body: updateDimensionSchema })
  update(
    @Param("dimensionId", ParseIntPipe) dimensionId: number,
    @Body() body: UpdateDimensionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateDimension(u, dimensionId, body);
  }

  @Get(":dimensionId/values")
  @RequirePermission("accounting:dimensions:read")
  @Validate({ params: dimensionIdParams })
  listValues(
    @Param("dimensionId", ParseIntPipe) dimensionId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listValues(u.orgId, dimensionId);
  }

  @Post(":dimensionId/values")
  @RequirePermission("accounting:dimensions:manage")
  @Validate({ params: dimensionIdParams, body: createDimensionValueSchema })
  createValue(
    @Param("dimensionId", ParseIntPipe) dimensionId: number,
    @Body() body: CreateDimensionValueInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createValue(u, dimensionId, body);
  }

  @Patch(":dimensionId/values/:valueId")
  @RequirePermission("accounting:dimensions:manage")
  @Validate({ params: dimensionIdvalueIdParams, body: updateDimensionValueSchema })
  updateValue(
    @Param("dimensionId", ParseIntPipe) dimensionId: number,
    @Param("valueId", ParseIntPipe) valueId: number,
    @Body() body: UpdateDimensionValueInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateValue(u, dimensionId, valueId, body);
  }
}
