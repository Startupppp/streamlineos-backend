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
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ChangeRequestsService } from "./change-requests.service";
import {
  createChangeRequestSchema,
  listCrQuerySchema,
  updateChangeRequestSchema,
  type CreateChangeRequestInput,
  type ListCrQuery,
  type UpdateChangeRequestInput,
} from "./dto/change-requests.schemas";

@RequireModule("projects")
@Controller("projects/:projectId/change-requests")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ChangeRequestsController {
  constructor(private readonly svc: ChangeRequestsService) {}

  @Get()
  @RequirePermission("projects:changerequests:view")
  listChangeRequests(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query(new ZodValidationPipe(listCrQuerySchema)) query: ListCrQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listChangeRequests(u.orgId, projectId, query);
  }

  @Get(":changeRequestId")
  @RequirePermission("projects:changerequests:view")
  getChangeRequest(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("changeRequestId", ParseIntPipe) changeRequestId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getChangeRequest(u.orgId, projectId, changeRequestId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("projects:changerequests:create")
  createChangeRequest(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createChangeRequestSchema)) body: CreateChangeRequestInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createChangeRequest(u.orgId, u.userId, projectId, body);
  }

  @Patch(":changeRequestId")
  @RequirePermission("projects:changerequests:manage")
  updateChangeRequest(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("changeRequestId", ParseIntPipe) changeRequestId: number,
    @Body(new ZodValidationPipe(updateChangeRequestSchema)) body: UpdateChangeRequestInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateChangeRequest(u.orgId, u.userId, projectId, changeRequestId, body);
  }

  @Delete(":changeRequestId")
  @RequirePermission("projects:changerequests:manage")
  @HttpCode(204)
  deleteChangeRequest(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("changeRequestId", ParseIntPipe) changeRequestId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteChangeRequest(u.orgId, projectId, changeRequestId);
  }
}
