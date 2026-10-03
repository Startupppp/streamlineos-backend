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
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { PublishingService } from "./publishing.service";
import { publishSchema, type PublishInput } from "./dto/payout.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { ApiOkResponse } from "@nestjs/swagger";
import {
  publishResponseSchema,
  retryPublishResponseSchema,
  retryOnePublishResponseSchema,
  publicationListSchema,
} from "./dto/payout-response.schemas";
import { z } from "zod";

const runIdParams = z.object({ runId: z.coerce.number().int().positive() }).strict();
const runEmployeeParams = z.object({
  runId: z.coerce.number().int().positive(),
  runEmployeeId: z.coerce.number().int().positive(),
}).strict();
const publicationIdParams = z.object({ publicationId: z.coerce.number().int().positive() }).strict();

@Controller("payroll")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class PublishingController {
  constructor(private readonly publishing: PublishingService) {}

  @Post("runs/:runId/payslips/publish")
  @HttpCode(200)
  @RequireModule("payroll")
  @RequirePermission("payroll:payslips:manage")
  @Idempotent("payroll.payslips.publish")
  @Validate({ params: runIdParams, body: publishSchema })
  @ResponseSchema(publishResponseSchema)
  publish(
    @Param("runId", ParseIntPipe) runId: number,
    @Body() body: PublishInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.publishing.publish(u.orgId, runId, u.userId, body.userIds, body.runEmployeeIds);
  }

  @Post("runs/:runId/employees/:runEmployeeId/release")
  @BodylessAction()
  @HttpCode(200)
  @RequireModule("payroll")
  @RequirePermission("payroll:runs:manage")
  @Validate({ params: runEmployeeParams })
  @ResponseSchema(publishResponseSchema)
  releaseHold(
    @Param("runId", ParseIntPipe) runId: number,
    @Param("runEmployeeId", ParseIntPipe) runEmployeeId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.publishing.releaseHold(u.orgId, runId, runEmployeeId, u.userId);
  }

  @Post("runs/:runId/payslips/retry-failed")
  @BodylessAction()
  @HttpCode(200)
  @RequireModule("payroll")
  @RequirePermission("payroll:payslips:manage")
  @Validate({ params: runIdParams })
  @ResponseSchema(retryPublishResponseSchema)
  retryFailed(
    @Param("runId", ParseIntPipe) runId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.publishing.retryFailed(u.orgId, runId, u.userId);
  }

  @Post("payslips/:publicationId/retry")
  @BodylessAction()
  @HttpCode(200)
  @RequireModule("payroll")
  @RequirePermission("payroll:payslips:manage")
  @Validate({ params: publicationIdParams })
  @ResponseSchema(retryOnePublishResponseSchema)
  retryOne(
    @Param("publicationId", ParseIntPipe) publicationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.publishing.retryFailedPublication(u.orgId, publicationId, u.userId);
  }

  @Get("runs/:runId/payslips")
  @RequireModule("payroll")
  @RequirePermission("payroll:payslips:view")
  @Validate({ params: runIdParams })
  @ResponseSchema(publicationListSchema)
  listPublications(
    @Param("runId", ParseIntPipe) runId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.publishing.listPublications(u.orgId, runId);
  }

  @Get("payslips/:publicationId/download")
  @RequirePermission("self:payslips")
  @Validate({ params: publicationIdParams })
  @ApiOkResponse({ content: { "application/pdf": { schema: { type: "string", format: "binary" } } } })
  downloadPdf(
    @Param("publicationId", ParseIntPipe) publicationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.publishing.downloadPdf(publicationId, u);
  }
}
