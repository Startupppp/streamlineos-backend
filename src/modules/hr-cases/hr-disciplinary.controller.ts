import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrDisciplinaryService } from "./hr-disciplinary.service";
import {
  createDisciplinaryActionSchema,
  listDisciplinarySchema,
  type CreateDisciplinaryActionInput,
  type ListDisciplinaryInput,
} from "./dto/hr-cases.schemas";

@RequireModule("hr")
@Controller("hr/cases/disciplinary")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrDisciplinaryController {
  constructor(private readonly disciplinary: HrDisciplinaryService) {}

  @Get()
  @RequirePermission("hr:cases:view")
  list(
    @CurrentUser() user: CurrentUserContext,
    @Query(new ZodValidationPipe(listDisciplinarySchema)) query: ListDisciplinaryInput,
  ) {
    return this.disciplinary.list(user.orgId, query);
  }

  @Get(":actionId")
  @RequirePermission("hr:cases:view")
  getById(
    @CurrentUser() user: CurrentUserContext,
    @Param("actionId", ParseIntPipe) actionId: number,
  ) {
    return this.disciplinary.getById(user.orgId, actionId);
  }

  @Post()
  @RequirePermission("hr:cases:manage")
  create(
    @CurrentUser() user: CurrentUserContext,
    @Body(new ZodValidationPipe(createDisciplinaryActionSchema)) body: CreateDisciplinaryActionInput,
    @Req() req: Request,
  ) {
    return this.disciplinary.create(user.orgId, user.userId, body, req.ip);
  }

  @Delete(":actionId")
  @RequirePermission("hr:cases:manage")
  @HttpCode(204)
  async delete(
    @CurrentUser() user: CurrentUserContext,
    @Param("actionId", ParseIntPipe) actionId: number,
  ) {
    await this.disciplinary.delete(user.orgId, actionId, user.userId);
  }
}
