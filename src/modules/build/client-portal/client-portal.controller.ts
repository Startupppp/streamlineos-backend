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
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { ClientPortalService } from "./client-portal.service";
import { createPortalCrSchema, type CreatePortalCrInput } from "./dto/client-portal.schemas";

@RequireModule("build")
@Controller("build/portal")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ClientPortalController {
  constructor(private readonly svc: ClientPortalService) {}

  @Get("projects")
  @RequirePermission("build:portal:view")
  listPortalProjects(@CurrentUser() u: CurrentUserContext) {
    return this.svc.listPortalProjects(u.orgId, u.userId);
  }

  @Get("projects/:projectId/overview")
  @RequirePermission("build:portal:view")
  getProjectOverview(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getProjectOverview(u.orgId, u.userId, projectId);
  }

  @Get("projects/:projectId/change-requests")
  @RequirePermission("build:changerequests:view")
  listPortalChangeRequests(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listPortalChangeRequests(u.orgId, u.userId, projectId);
  }

  @Post("projects/:projectId/change-requests")
  @HttpCode(201)
  @RequirePermission("build:changerequests:create")
  createPortalChangeRequest(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createPortalCrSchema)) body: CreatePortalCrInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createPortalChangeRequest(u.orgId, u.userId, projectId, body);
  }
}
