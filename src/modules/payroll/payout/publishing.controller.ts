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
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { PublishingService } from "./publishing.service";
import { publishSchema, type PublishInput } from "./dto/payout.schemas";

@Controller("payroll")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class PublishingController {
  constructor(private readonly publishing: PublishingService) {}

  @Post("runs/:runId/payslips/publish")
  @HttpCode(200)
  @RequirePermission("payroll:payslips:manage")
  publish(
    @Param("runId", ParseIntPipe) runId: number,
    @Body(new ZodValidationPipe(publishSchema)) body: PublishInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.publishing.publish(u.orgId, runId, u.userId, body.userIds);
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
  @UseGuards(JwtAuthGuard)
  downloadPdf(
    @Param("publicationId", ParseIntPipe) publicationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.publishing.downloadPdf(publicationId, u);
  }
}
