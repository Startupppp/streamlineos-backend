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
import { z } from "zod";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { WorkAuthorizationsService } from "./work-authorizations.service";
import {
  createWorkAuthSchema,
  updateWorkAuthSchema,
  listWorkAuthSchema,
  type CreateWorkAuthInput,
  type UpdateWorkAuthInput,
  type ListWorkAuthInput,
} from "./dto/hr-global.schemas";

const daysQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(3650).default(30) });

@RequireModule("hr")
@Controller("hr/global/work-authorizations")
@UseGuards(JwtAuthGuard)
export class WorkAuthorizationsController {
  constructor(private readonly service: WorkAuthorizationsService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:read")
  list(
    @Query(new ZodValidationPipe(listWorkAuthSchema)) query: ListWorkAuthInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.list(u.orgId, query);
  }

  @Get("expiring")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compliance:manage")
  listExpiring(
    @Query(new ZodValidationPipe(daysQuerySchema)) { days }: z.infer<typeof daysQuerySchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.list(u.orgId, { page: 1, limit: 100, days });
  }

  @Get(":authId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:read")
  getOne(
    @Param("authId", ParseIntPipe) authId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getOne(u.orgId, authId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compliance:manage")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createWorkAuthSchema)) body: CreateWorkAuthInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.create(u.orgId, u.userId, body);
  }

  @Patch(":authId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compliance:manage")
  update(
    @Param("authId", ParseIntPipe) authId: number,
    @Body(new ZodValidationPipe(updateWorkAuthSchema)) body: UpdateWorkAuthInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.update(u.orgId, authId, u.userId, body);
  }

  @Delete(":authId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compliance:manage")
  remove(
    @Param("authId", ParseIntPipe) authId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.remove(u.orgId, authId, u.userId);
  }
}
