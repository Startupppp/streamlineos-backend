import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import {
  createLeaveSchema,
  type CreateLeaveInput,
} from "./dto/leaves.schemas";
import {
  createWfhSchema,
  type CreateWfhInput,
} from "./dto/wfh.schemas";
import { LeavesPageService } from "./leaves-page.service";
import { LeavesService } from "./leaves.service";
import { LeavesWriteService } from "./leaves-write.service";
import { WfhService } from "./wfh.service";

@Controller("me/time-off")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class EmployeeTimeOffController {
  constructor(
    private readonly leaves: LeavesService,
    private readonly leavesWrite: LeavesWriteService,
    private readonly leavesPage: LeavesPageService,
    private readonly wfh: WfhService,
  ) {}

  @Get()
  @RequirePermission("self:leaves")
  pageData(@CurrentUser() user: CurrentUserContext) {
    return this.leavesPage.pageData(user.orgId, user.userId);
  }

  @Get("requests")
  @RequirePermission("self:leaves")
  requests(@CurrentUser() user: CurrentUserContext) {
    return this.leaves.my(user.orgId, user.userId);
  }

  @Get("team-calendar")
  @RequirePermission("self:leaves")
  teamCalendar(@CurrentUser() user: CurrentUserContext) {
    return this.leaves.thisWeek(user.orgId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("self:leaves")
  create(
    @Body(new ZodValidationPipe(createLeaveSchema)) body: CreateLeaveInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.leavesWrite.create(user, body);
  }

  @Patch(":leaveId/cancel")
  @RequirePermission("self:leaves")
  async cancel(
    @Param("leaveId", ParseIntPipe) leaveId: number,
    @CurrentUser() user: CurrentUserContext,
  ) {
    const result = await this.leavesWrite.cancel(user, leaveId);
    if (!result.ok) throw new NotFoundException("Leave request not found.");
    return { success: true };
  }

  @Get("wfh")
  @RequirePermission("self:attendance")
  listWfh(@CurrentUser() user: CurrentUserContext) {
    return this.wfh.list(user.orgId, user.userId);
  }

  @Post("wfh")
  @HttpCode(201)
  @RequirePermission("self:attendance")
  createWfh(
    @Body(new ZodValidationPipe(createWfhSchema)) body: CreateWfhInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.wfh.create(user.orgId, user.userId, body);
  }
}
