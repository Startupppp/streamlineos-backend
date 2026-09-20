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
import { ClientPortalService } from "./client-portal.service";
import { createPortalCrSchema, type CreatePortalCrInput } from "./dto/client-portal.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  portalProjectItemSchema,
  portalProjectOverviewSchema,
  portalChangeRequestItemSchema,
} from "./dto/client-portal-response.schemas";

const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build/portal")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ClientPortalController {
  constructor(private readonly svc: ClientPortalService) {}

  @Get("projects")
  @RequirePermission("build:portal:view")
  @ResponseSchema(z.array(portalProjectItemSchema))
  listPortalProjects(@CurrentUser() u: CurrentUserContext) {
    return this.svc.listPortalProjects(u.orgId);
  }

  @Get("projects/:projectId/overview")
  @RequirePermission("build:portal:view")
  @ResponseSchema(portalProjectOverviewSchema)
  @Validate({ params: projectIdParams })
  getProjectOverview(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getProjectOverview(u, projectId);
  }

  @Get("projects/:projectId/change-requests")
  @RequirePermission("build:changerequests:view")
  @ResponseSchema(z.array(portalChangeRequestItemSchema))
  @Validate({ params: projectIdParams })
  listPortalChangeRequests(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listPortalChangeRequests(u, projectId);
  }

  @Post("projects/:projectId/change-requests")
  @HttpCode(201)
  @RequirePermission("build:changerequests:create")
  @ResponseSchema(portalChangeRequestItemSchema)
  @Validate({ params: projectIdParams, body: createPortalCrSchema })
  createPortalChangeRequest(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: CreatePortalCrInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createPortalChangeRequest(u, projectId, body);
  }
}
