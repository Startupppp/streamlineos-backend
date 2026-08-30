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
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ChangeRequestsService } from "./change-requests.service";
import {
  createChangeRequestSchema,
  listCrQuerySchema,
  updateChangeRequestSchema,
  type CreateChangeRequestInput,
  type ListCrQuery,
  type UpdateChangeRequestInput,
} from "./dto/change-requests.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() }).strict();
const projectAndChangeRequestIdParams = z.object({ projectId: z.coerce.number().int().positive(), changeRequestId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build/:projectId/change-requests")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ChangeRequestsController {
  constructor(private readonly svc: ChangeRequestsService) {}

  @Get()
  @RequirePermission("build:changerequests:view")
  @Validate({ params: projectIdParams, query: listCrQuerySchema })
  listChangeRequests(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query() query: ListCrQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listChangeRequests(u.orgId, projectId, query);
  }

  @Get(":changeRequestId")
  @RequirePermission("build:changerequests:view")
  @Validate({ params: projectAndChangeRequestIdParams })
  getChangeRequest(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("changeRequestId", ParseIntPipe) changeRequestId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getChangeRequest(u.orgId, projectId, changeRequestId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:changerequests:create")
  @Validate({ params: projectIdParams, body: createChangeRequestSchema })
  createChangeRequest(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: CreateChangeRequestInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createChangeRequest(u.orgId, u.userId, projectId, body);
  }

  @Patch(":changeRequestId")
  @RequirePermission("build:changerequests:manage")
  @Validate({ params: projectAndChangeRequestIdParams, body: updateChangeRequestSchema })
  updateChangeRequest(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("changeRequestId", ParseIntPipe) changeRequestId: number,
    @Body() body: UpdateChangeRequestInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateChangeRequest(u.orgId, u.userId, projectId, changeRequestId, body);
  }

  @Delete(":changeRequestId")
  @RequirePermission("build:changerequests:manage")
  @HttpCode(204)
  @Validate({ params: projectAndChangeRequestIdParams })
  deleteChangeRequest(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("changeRequestId", ParseIntPipe) changeRequestId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteChangeRequest(u.orgId, projectId, changeRequestId);
  }
}
