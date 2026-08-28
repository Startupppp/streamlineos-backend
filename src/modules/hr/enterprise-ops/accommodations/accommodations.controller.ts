import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../../common/pipes/zod-validation.pipe";
import { AccessService } from "../../../access/access.service";
import { AccommodationsService } from "./accommodations.service";
import {
  createAccommodationSchema,
  updateAccommodationSchema,
  approveAccommodationSchema,
  listAccommodationsSchema,
  createAccommodationTaskSchema,
  updateAccommodationTaskSchema,
  type CreateAccommodationInput,
  type UpdateAccommodationInput,
  type ApproveAccommodationInput,
  type ListAccommodationsInput,
  type CreateAccommodationTaskInput,
  type UpdateAccommodationTaskInput,
} from "../dto/accommodations.schemas";
import { Idempotent } from "../../../../common/idempotency/idempotent.decorator";

@RequireModule("hr")
@Controller("hr/enterprise/ops/accommodations")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class AccommodationsController {
  constructor(
    private readonly svc: AccommodationsService,
    private readonly access: AccessService,
  ) {}

  private async hasSensitive(user: CurrentUserContext): Promise<boolean> {
    const perms = await this.access.resolveUserPermissions(user.orgId, user.userId);
    return perms.has("hr:sensitive:view");
  }

  @Get()
  @RequirePermission("hr:accommodations:view")
  async list(
    @CurrentUser() user: CurrentUserContext,
    @Query(new ZodValidationPipe(listAccommodationsSchema)) query: ListAccommodationsInput,
  ) {
    const sensitive = await this.hasSensitive(user);
    return this.svc.list(user.orgId, query, sensitive);
  }

  @Get(":accommodationId")
  @RequirePermission("hr:accommodations:view")
  async getById(
    @CurrentUser() user: CurrentUserContext,
    @Param("accommodationId") accommodationId: string,
  ) {
    const sensitive = await this.hasSensitive(user);
    return this.svc.getById(user.orgId, accommodationId, sensitive);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:accommodations:manage")
  async create(
    @CurrentUser() user: CurrentUserContext,
    @Body(new ZodValidationPipe(createAccommodationSchema)) body: CreateAccommodationInput,
    @Req() req: Request,
  ) {
    return this.svc.create(user.orgId, user.userId, body, req.ip, req.headers["user-agent"]);
  }

  @Patch(":accommodationId")
  @RequirePermission("hr:accommodations:manage")
  async update(
    @CurrentUser() user: CurrentUserContext,
    @Param("accommodationId") accommodationId: string,
    @Body(new ZodValidationPipe(updateAccommodationSchema)) body: UpdateAccommodationInput,
    @Req() req: Request,
  ) {
    return this.svc.update(user.orgId, accommodationId, user.userId, body, req.ip, req.headers["user-agent"]);
  }

  @Delete(":accommodationId")
  @HttpCode(204)
  @RequirePermission("hr:accommodations:manage")
  async remove(
    @CurrentUser() user: CurrentUserContext,
    @Param("accommodationId") accommodationId: string,
    @Req() req: Request,
  ) {
    await this.svc.softDelete(user.orgId, accommodationId, user.userId, req.ip, req.headers["user-agent"]);
  }

  @Post(":accommodationId/approve")
  @Idempotent("hr.accommodation.approve")
  @RequirePermission("hr:accommodations:manage")
  async approve(
    @CurrentUser() user: CurrentUserContext,
    @Param("accommodationId") accommodationId: string,
    @Body(new ZodValidationPipe(approveAccommodationSchema)) body: ApproveAccommodationInput,
    @Req() req: Request,
  ) {
    return this.svc.approve(user.orgId, accommodationId, user.userId, body, req.ip, req.headers["user-agent"]);
  }

  @Get(":accommodationId/tasks")
  @RequirePermission("hr:accommodations:view")
  async listTasks(
    @CurrentUser() user: CurrentUserContext,
    @Param("accommodationId") accommodationId: string,
  ) {
    return this.svc.listTasks(user.orgId, accommodationId);
  }

  @Post(":accommodationId/tasks")
  @HttpCode(201)
  @RequirePermission("hr:accommodations:manage")
  async createTask(
    @CurrentUser() user: CurrentUserContext,
    @Param("accommodationId") accommodationId: string,
    @Body(new ZodValidationPipe(createAccommodationTaskSchema)) body: CreateAccommodationTaskInput,
  ) {
    return this.svc.createTask(user.orgId, accommodationId, body);
  }

  @Patch(":accommodationId/tasks/:taskId")
  @RequirePermission("hr:accommodations:manage")
  async updateTask(
    @CurrentUser() user: CurrentUserContext,
    @Param("accommodationId") accommodationId: string,
    @Param("taskId") taskId: string,
    @Body(new ZodValidationPipe(updateAccommodationTaskSchema)) body: UpdateAccommodationTaskInput,
  ) {
    return this.svc.updateTask(user.orgId, accommodationId, taskId, body);
  }

  @Delete(":accommodationId/tasks/:taskId")
  @HttpCode(204)
  @RequirePermission("hr:accommodations:manage")
  async deleteTask(
    @CurrentUser() user: CurrentUserContext,
    @Param("accommodationId") accommodationId: string,
    @Param("taskId") taskId: string,
  ) {
    await this.svc.deleteTask(user.orgId, accommodationId, taskId);
  }
}
