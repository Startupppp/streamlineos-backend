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
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { PublishingService } from "./publishing.service";
import { publishSchema, type PublishInput } from "./dto/payout.schemas";

@RequireModule("payroll")
@Controller("payroll")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class PublishingController {
  constructor(private readonly publishing: PublishingService) {}

  @Post("runs/:runId/payslips/publish")
  @HttpCode(200)
  @RequirePermission("payroll:payslips:manage")
  @Idempotent("payroll.payslips.publish")
  publish(
    @Param("runId", ParseIntPipe) runId: number,
    @Body(new ZodValidationPipe(publishSchema)) body: PublishInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.publishing.publish(u.orgId, runId, u.userId, body.userIds);
  }

  @Post("runs/:runId/payslips/retry-failed")
  @HttpCode(200)
  @RequirePermission("payroll:payslips:manage")
  retryFailed(
    @Param("runId", ParseIntPipe) runId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.publishing.retryFailed(u.orgId, runId, u.userId);
  }

  @Post("payslips/:publicationId/retry")
  @HttpCode(200)
  @RequirePermission("payroll:payslips:manage")
  retryOne(
    @Param("publicationId", ParseIntPipe) publicationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.publishing.retryFailedPublication(u.orgId, publicationId, u.userId);
  }

  @Get("runs/:runId/payslips")
  @RequirePermission("payroll:payslips:view")
  listPublications(
    @Param("runId", ParseIntPipe) runId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.publishing.listPublications(u.orgId, runId);
  }

  @Get("payslips/:publicationId/download")
  @RequirePermission("self:payslips")
  downloadPdf(
    @Param("publicationId", ParseIntPipe) publicationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.publishing.downloadPdf(publicationId, u);
  }
}
