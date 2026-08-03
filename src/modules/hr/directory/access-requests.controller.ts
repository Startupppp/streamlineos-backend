import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { AccessRequestsService } from "./access-requests.service";
import {
  createAccessRequestSchema,
  patchAccessRequestSchema,
  type CreateAccessRequestInput,
  type PatchAccessRequestInput,
} from "./dto/hr-directory.schemas";

@RequireModule("hr")
@Controller("hr/access-requests")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class AccessRequestsController {
  constructor(private readonly service: AccessRequestsService) {}

  @Get()
  @RequirePermission("hr:assets:view")
  list(
    @Query("employeeId") employeeId: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.list(u.orgId, employeeId);
  }

  @Post()
  @RequirePermission("hr:assets:manage")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createAccessRequestSchema)) body: CreateAccessRequestInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.create(u.orgId, body);
  }

  @Patch(":requestId")
  @RequirePermission("hr:assets:manage")
  update(
    @Param("requestId") requestId: string,
    @Body(new ZodValidationPipe(patchAccessRequestSchema)) body: PatchAccessRequestInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.update(u.orgId, requestId, body, u.userId);
  }
}
