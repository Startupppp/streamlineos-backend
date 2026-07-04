import {
  Body,
  Controller,
  Delete,
  Get,
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
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { PayrollComponentsService } from "./components.service";
import {
  listComponentsSchema,
  createComponentSchema,
  updateComponentSchema,
  type ListComponentsInput,
  type CreateComponentInput,
  type UpdateComponentInput,
} from "./dto/setup.schemas";

@Controller("payroll/components")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class PayrollComponentsController {
  constructor(private readonly service: PayrollComponentsService) {}

  @Get()
  @RequirePermission("payroll:components:view")
  async list(
    @Query(new ZodValidationPipe(listComponentsSchema)) query: ListComponentsInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.service.list(u.orgId, query);
  }

  @Post()
  @RequirePermission("payroll:components:manage")
  async create(
    @Body(new ZodValidationPipe(createComponentSchema)) body: CreateComponentInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.service.create(u, body);
  }

  @Patch(":componentId")
  @RequirePermission("payroll:components:manage")
  async update(
    @Param("componentId", ParseIntPipe) componentId: number,
    @Body(new ZodValidationPipe(updateComponentSchema)) body: UpdateComponentInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.service.update(u, componentId, body);
  }

  @Delete(":componentId")
  @RequirePermission("payroll:components:manage")
  async remove(
    @Param("componentId", ParseIntPipe) componentId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.service.remove(u, componentId);
  }
}
