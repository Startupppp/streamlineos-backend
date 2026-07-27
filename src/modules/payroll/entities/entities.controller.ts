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
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { PayrollEntitiesService } from "./entities.service";
import { createEntitySchema, type CreateEntityInput } from "./dto/entities.schemas";

@RequireModule("payroll")
@Controller("payroll/entities")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class PayrollEntitiesController {
  constructor(private readonly service: PayrollEntitiesService) {}

  @Get()
  @RequirePermission("payroll:policies:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.service.list(u.orgId);
  }

  /** Country pack catalog with maturity honesty labels. */
  @Get("country-packs")
  @RequirePermission("payroll:policies:view")
  countryPacks() {
    return this.service.listCountryPacks();
  }

  @Get(":entityId/context")
  @RequirePermission("payroll:policies:view")
  context(
    @CurrentUser() u: CurrentUserContext,
    @Param("entityId", ParseIntPipe) entityId: number,
  ) {
    return this.service.getEntityContext(u.orgId, entityId);
  }

  @Get(":entityId")
  @RequirePermission("payroll:policies:view")
  get(
    @CurrentUser() u: CurrentUserContext,
    @Param("entityId", ParseIntPipe) entityId: number,
  ) {
    return this.service.getEntity(u.orgId, entityId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("payroll:policies:manage")
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(createEntitySchema)) body: CreateEntityInput,
  ) {
    return this.service.create(u.orgId, u.userId, body);
  }
}
