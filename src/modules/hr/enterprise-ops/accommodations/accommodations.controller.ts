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
import { Validate } from "../../../../common/validation/validate.decorator";
import { z } from "zod";

const accommodationIdParams = z.object({ accommodationId: z.string().uuid() }).strict();
const accommodationIdtaskIdParams = z.object({ accommodationId: z.string().uuid(), taskId: z.string().uuid() }).strict();

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
  @Validate({ query: listAccommodationsSchema })
  async list(
    @CurrentUser() user: CurrentUserContext,
    @Query() query: ListAccommodationsInput,
  ) {
    const sensitive = await this.hasSensitive(user);
    return this.svc.list(user.orgId, query, sensitive);
  }

  @Get(":accommodationId")
  @RequirePermission("hr:accommodations:view")
  @Validate({ params: accommodationIdParams })
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
  @Validate({ body: createAccommodationSchema })
  async create(
    @CurrentUser() user: CurrentUserContext,
    @Body() body: CreateAccommodationInput,
    @Req() req: Request,
  ) {
    return this.svc.create(user.orgId, user.userId, body, req.ip, req.headers["user-agent"]);
  }

  @Patch(":accommodationId")
  @RequirePermission("hr:accommodations:manage")
  @Validate({ params: accommodationIdParams, body: updateAccommodationSchema })
  async update(
    @CurrentUser() user: CurrentUserContext,
    @Param("accommodationId") accommodationId: string,
    @Body() body: UpdateAccommodationInput,
    @Req() req: Request,
  ) {
    return this.svc.update(user.orgId, accommodationId, user.userId, body, req.ip, req.headers["user-agent"]);
  }

  @Delete(":accommodationId")
  @HttpCode(204)
  @RequirePermission("hr:accommodations:manage")
  @Validate({ params: accommodationIdParams })
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
  @Validate({ params: accommodationIdParams, body: approveAccommodationSchema })
  async approve(
    @CurrentUser() user: CurrentUserContext,
    @Param("accommodationId") accommodationId: string,
    @Body() body: ApproveAccommodationInput,
    @Req() req: Request,
  ) {
    return this.svc.approve(user.orgId, accommodationId, user.userId, body, req.ip, req.headers["user-agent"]);
  }

  @Get(":accommodationId/tasks")
  @RequirePermission("hr:accommodations:view")
  @Validate({ params: accommodationIdParams })
  async listTasks(
    @CurrentUser() user: CurrentUserContext,
    @Param("accommodationId") accommodationId: string,
  ) {
    return this.svc.listTasks(user.orgId, accommodationId);
  }

  @Post(":accommodationId/tasks")
  @HttpCode(201)
  @RequirePermission("hr:accommodations:manage")
  @Validate({ params: accommodationIdParams, body: createAccommodationTaskSchema })
  async createTask(
    @CurrentUser() user: CurrentUserContext,
    @Param("accommodationId") accommodationId: string,
    @Body() body: CreateAccommodationTaskInput,
  ) {
    return this.svc.createTask(user.orgId, accommodationId, body);
  }

  @Patch(":accommodationId/tasks/:taskId")
  @RequirePermission("hr:accommodations:manage")
  @Validate({ params: accommodationIdtaskIdParams, body: updateAccommodationTaskSchema })
  async updateTask(
    @CurrentUser() user: CurrentUserContext,
    @Param("accommodationId") accommodationId: string,
    @Param("taskId") taskId: string,
    @Body() body: UpdateAccommodationTaskInput,
  ) {
    return this.svc.updateTask(user.orgId, accommodationId, taskId, body);
  }

  @Delete(":accommodationId/tasks/:taskId")
  @HttpCode(204)
  @RequirePermission("hr:accommodations:manage")
  @Validate({ params: accommodationIdtaskIdParams })
  async deleteTask(
    @CurrentUser() user: CurrentUserContext,
    @Param("accommodationId") accommodationId: string,
    @Param("taskId") taskId: string,
  ) {
    await this.svc.deleteTask(user.orgId, accommodationId, taskId);
  }
}
