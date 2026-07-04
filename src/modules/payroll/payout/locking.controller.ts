import { Body, Controller, HttpCode, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { LockingService } from "./locking.service";
import { reopenRunSchema, type ReopenRunInput } from "./dto/payout.schemas";

@Controller("payroll/runs/:runId")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class LockingController {
  constructor(private readonly locking: LockingService) {}

  @Post("lock")
  @HttpCode(200)
  @RequirePermission("payroll:runs:manage")
  lock(
    @Param("runId", ParseIntPipe) runId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.locking.lock(u.orgId, u.userId, runId);
  }

  @Post("reopen")
  @HttpCode(200)
  @RequirePermission("payroll:runs:manage")
  reopen(
    @Param("runId", ParseIntPipe) runId: number,
    @Body(new ZodValidationPipe(reopenRunSchema)) body: ReopenRunInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.locking.reopen(u.orgId, u.userId, runId, body.reason);
  }

  @Post("close")
  @HttpCode(200)
  @RequirePermission("payroll:runs:manage")
  close(
    @Param("runId", ParseIntPipe) runId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.locking.close(u.orgId, u.userId, runId);
  }
}
