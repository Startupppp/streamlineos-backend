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
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import {
  createLeaveSchema,
  listLeaveRequestsSchema,
  type CreateLeaveInput,
  type ListLeaveRequestsQuery,
} from "./dto/leaves.schemas";
import {
  createWfhSchema,
  type CreateWfhInput,
} from "./dto/wfh.schemas";
import { LeavesPageService } from "./leaves-page.service";
import { LeavesService } from "./leaves.service";
import { LeavesWriteService } from "./leaves-write.service";
import { WfhService } from "./wfh.service";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";

const leaveIdParams = z.object({ leaveId: z.coerce.number().int().positive() }).strict();

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
  @Validate({ query: listLeaveRequestsSchema })
  requests(
    @Query() query: ListLeaveRequestsQuery,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.leaves.my(user.orgId, user.userId, query);
  }

  @Get("team-calendar")
  @RequirePermission("self:leaves")
  teamCalendar(@CurrentUser() user: CurrentUserContext) {
    return this.leaves.thisWeek(user.orgId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("self:leaves")
  @Validate({ body: createLeaveSchema })
  create(
    @Body() body: CreateLeaveInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.leavesWrite.create(user, body);
  }

  @Patch(":leaveId/cancel")
  @BodylessAction()
  @RequirePermission("self:leaves")
  @Validate({ params: leaveIdParams })
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
  @Validate({ body: createWfhSchema })
  createWfh(
    @Body() body: CreateWfhInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.wfh.create(user.orgId, user.userId, body);
  }
}
