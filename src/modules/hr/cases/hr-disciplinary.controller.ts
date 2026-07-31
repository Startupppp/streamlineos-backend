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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { HrDisciplinaryService } from "./hr-disciplinary.service";
import {
  createDisciplinaryActionSchema,
  listDisciplinarySchema,
  acknowledgeDisciplinarySchema,
  type CreateDisciplinaryActionInput,
  type ListDisciplinaryInput,
  type AcknowledgeDisciplinaryInput,
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

  /** Employee: disciplinary actions issued to me. */
  @Get("mine")
  @RequirePermission("self:cases")
  listMine(@CurrentUser() user: CurrentUserContext) {
    return this.disciplinary.listMine(user.orgId, user.userId);
  }

  @Get("mine/unacknowledged-count")
  @RequirePermission("self:cases")
  unacknowledgedCount(@CurrentUser() user: CurrentUserContext) {
    return this.disciplinary.listUnacknowledgedCount(user.orgId, user.userId);
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
  @HttpCode(201)
  @RequirePermission("hr:cases:manage")
  create(
    @CurrentUser() user: CurrentUserContext,
    @Body(new ZodValidationPipe(createDisciplinaryActionSchema)) body: CreateDisciplinaryActionInput,
    @Req() req: Request,
  ) {
    return this.disciplinary.create(user.orgId, user.userId, body, req.ip);
  }

  /** Employee acknowledges receipt (not agreement). */
  @Post(":actionId/acknowledge")
  @HttpCode(200)
  @RequirePermission("self:cases")
  acknowledge(
    @CurrentUser() user: CurrentUserContext,
    @Param("actionId", ParseIntPipe) actionId: number,
    @Body(new ZodValidationPipe(acknowledgeDisciplinarySchema))
    body: AcknowledgeDisciplinaryInput,
  ) {
    return this.disciplinary.acknowledge(user.orgId, user.userId, actionId, body.note);
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
