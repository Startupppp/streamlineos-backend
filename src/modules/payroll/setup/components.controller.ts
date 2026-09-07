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
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { PayrollComponentsService } from "./components.service";
import {
  listComponentsSchema,
  createComponentSchema,
  updateComponentSchema,
  type ListComponentsInput,
  type CreateComponentInput,
  type UpdateComponentInput,
} from "./dto/setup.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema, NoContentResponse } from "../../../common/openapi/zod-operation-contracts";
import {
  componentListResponseSchema,
  salaryComponentSchema,
} from "./dto/setup-response.schemas";
import { z } from "zod";

const componentIdParams = z.object({ componentId: z.coerce.number().int().positive() }).strict();

@RequireModule("payroll")
@Controller("payroll/components")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class PayrollComponentsController {
  constructor(private readonly service: PayrollComponentsService) {}

  @Get()
  @RequirePermission("payroll:components:view")
  @Validate({ query: listComponentsSchema })
  @ResponseSchema(componentListResponseSchema)
  async list(
    @Query() query: ListComponentsInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.service.list(u.orgId, query);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("payroll:components:manage")
  @Validate({ body: createComponentSchema })
  @ResponseSchema(salaryComponentSchema)
  async create(
    @Body() body: CreateComponentInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.service.create(u, body);
  }

  @Patch(":componentId")
  @RequirePermission("payroll:components:manage")
  @Validate({ params: componentIdParams, body: updateComponentSchema })
  @ResponseSchema(salaryComponentSchema)
  async update(
    @Param("componentId", ParseIntPipe) componentId: number,
    @Body() body: UpdateComponentInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.service.update(u, componentId, body);
  }

  @Delete(":componentId")
  @HttpCode(204)
  @RequirePermission("payroll:components:manage")
  @Validate({ params: componentIdParams })
  @NoContentResponse()
  async remove(
    @Param("componentId", ParseIntPipe) componentId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.service.remove(u, componentId);
  }
}
