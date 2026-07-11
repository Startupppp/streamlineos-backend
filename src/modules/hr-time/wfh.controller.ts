import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { WfhService } from "./wfh.service";
import {
  createWfhSchema,
  updateWfhSchema,
  type CreateWfhInput,
  type UpdateWfhInput,
} from "./dto/wfh.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("hr")
@Controller("hr/wfh")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class WfhController {
  constructor(private readonly wfh: WfhService) {}

  @Get()
  @RequirePermission("hr:attendance:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.wfh.list(u.orgId, u.userId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:attendance:view")
  create(
    @Body(new ZodValidationPipe(createWfhSchema)) body: CreateWfhInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.wfh.create(u.orgId, u.userId, body);
  }

  @Get("pending")
  @RequirePermission("hr:attendance:manage")
  pending(@CurrentUser() u: CurrentUserContext) {
    return this.wfh.pending(u.orgId);
  }

  @Patch(":requestId")
  @RequirePermission("hr:attendance:manage")
  update(
    @Param("requestId", ParseIntPipe) requestId: number,
    @Body(new ZodValidationPipe(updateWfhSchema)) body: UpdateWfhInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.wfh.update(u.orgId, u.userId, requestId, body);
  }
}
