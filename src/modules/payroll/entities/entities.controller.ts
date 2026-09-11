import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { PayrollEntitiesService } from "./entities.service";
import { createEntitySchema, type CreateEntityInput } from "./dto/entities.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { payrollEntitySchema, payrollEntityListResponseSchema, countryPacksResponseSchema, entityContextResponseSchema } from "./dto/entities-response.schemas";
import { z } from "zod";

const entityIdParams = z.object({ entityId: z.coerce.number().int().positive() }).strict();

@RequireModule("payroll")
@Controller("payroll/entities")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class PayrollEntitiesController {
  constructor(private readonly service: PayrollEntitiesService) {}

  @Get()
  @RequirePermission("payroll:policies:view")
  @ResponseSchema(payrollEntityListResponseSchema)
  list(@CurrentUser() u: CurrentUserContext) {
    return this.service.list(u.orgId);
  }

  @Get("country-packs")
  @RequirePermission("payroll:policies:view")
  @ResponseSchema(countryPacksResponseSchema)
  countryPacks() {
    return this.service.listCountryPacks();
  }

  @Get(":entityId/context")
  @RequirePermission("payroll:policies:view")
  @ResponseSchema(entityContextResponseSchema)
  @Validate({ params: entityIdParams })
  context(
    @CurrentUser() u: CurrentUserContext,
    @Param("entityId", ParseIntPipe) entityId: number,
  ) {
    return this.service.getEntityContext(u.orgId, entityId);
  }

  @Get(":entityId")
  @RequirePermission("payroll:policies:view")
  @Validate({ params: entityIdParams })
  @ResponseSchema(payrollEntitySchema)
  get(
    @CurrentUser() u: CurrentUserContext,
    @Param("entityId", ParseIntPipe) entityId: number,
  ) {
    return this.service.getEntity(u.orgId, entityId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("payroll:policies:manage")
  @Validate({ body: createEntitySchema })
  @ResponseSchema(payrollEntitySchema)
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: CreateEntityInput,
  ) {
    return this.service.create(u.orgId, u.userId, body);
  }
}
