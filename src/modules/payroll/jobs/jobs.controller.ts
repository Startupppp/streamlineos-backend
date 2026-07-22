import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { PayrollJobsService } from "./payroll-jobs.service";

const listQuerySchema = z.object({
  failedOnly: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

@Controller("payroll/jobs")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class PayrollJobsController {
  constructor(private readonly jobs: PayrollJobsService) {}

  @Get()
  @RequirePermission("payroll:runs:view")
  async list(
    @CurrentUser() u: CurrentUserContext,
    @Query(new ZodValidationPipe(listQuerySchema)) query: z.infer<typeof listQuerySchema>,
  ) {
    if (query.failedOnly) {
      return this.jobs.listFailed(u.orgId);
    }
    return this.jobs.listFailed(u.orgId);
  }

  @Get(":jobId")
  @RequirePermission("payroll:runs:view")
  get(
    @CurrentUser() u: CurrentUserContext,
    @Param("jobId", ParseIntPipe) jobId: number,
  ) {
    return this.jobs.get(u.orgId, jobId);
  }

  @Post(":jobId/retry")
  @HttpCode(200)
  @RequirePermission("payroll:runs:manage")
  retry(
    @CurrentUser() u: CurrentUserContext,
    @Param("jobId", ParseIntPipe) jobId: number,
  ) {
    return this.jobs.retry(u.orgId, jobId);
  }
}
