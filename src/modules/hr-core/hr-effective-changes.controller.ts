import {
  Body,
  Controller,
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
import { HrEffectiveChangesService } from "./hr-effective-changes.service";
import {
  applyDueChangesSchema,
  createEffectiveDateChangeSchema,
  listEffectiveDateChangesSchema,
  type ApplyDueChangesInput,
  type CreateEffectiveDateChangeInput,
  type ListEffectiveDateChangesInput,
} from "./dto/hr-core.schemas";

@RequireModule("hr")
@Controller("hr/effective-changes")
@UseGuards(JwtAuthGuard)
export class HrEffectiveChangesController {
  constructor(private readonly service: HrEffectiveChangesService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:read")
  list(
    @Query(new ZodValidationPipe(listEffectiveDateChangesSchema)) query: ListEffectiveDateChangesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.list(u.orgId, query);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createEffectiveDateChangeSchema)) body: CreateEffectiveDateChangeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.create(u.orgId, u.userId, body);
  }

  @Patch(":changeId/approve")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  approve(
    @Param("changeId", ParseIntPipe) changeId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.approve(u.orgId, changeId, u.userId);
  }

  @Post("apply-due")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  @HttpCode(200)
  applyDue(
    @Body(new ZodValidationPipe(applyDueChangesSchema)) body: ApplyDueChangesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.applyDueChanges(u.orgId, body.asOfDate);
  }
}
