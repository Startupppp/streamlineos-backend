import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrHelpdeskService } from "./hr-helpdesk.service";
import {
  createSchema,
  listSchema,
  type CreateInput,
  type ListInput,
} from "./dto/hr-helpdesk.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("hr")
@Controller("hr/helpdesk")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrHelpdeskController {
  constructor(private readonly helpdesk: HrHelpdeskService) {}

  @Get()
  @RequirePermission("hr:helpdesk:view")
  list(
    @Query(new ZodValidationPipe(listSchema)) filters: ListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const isAdmin = u.isOrgOwner || u.isPlatformAdmin || u.permissions.includes("hr:helpdesk:manage");
    return this.helpdesk.list(u.orgId, u.userId, isAdmin, filters);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:helpdesk:create")
  create(
    @Body(new ZodValidationPipe(createSchema)) body: CreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.helpdesk.create(u.orgId, u.userId, body);
  }
}
