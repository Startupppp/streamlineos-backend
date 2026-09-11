import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { actingMembershipId } from "../../common/auth/principal";
import { Validate } from "../../common/validation/validate.decorator";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { NoTenantTransaction } from "../../common/tenant/no-tenant-transaction.decorator";
import { SignBulkSendService } from "./sign-bulk-send.service";
import { createBulkSendJobSchema, type CreateBulkSendJobInput } from "./dto/e-sign.schemas";
import { BodylessAction } from "../../common/openapi/zod-operation-contracts";

const jobIdParams = z.object({ jobId: z.coerce.number().int().positive() }).strict();

@RequireModule("sign")
@Controller("sign/bulk-send")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SignBulkSendController {
  constructor(private readonly bulkSend: SignBulkSendService) {}

  /*
   * Opted out of the request transaction, and the opt-out is load-bearing in
   * both directions.
   *
   * A bulk send is up to 5000 envelopes, each one sending an invitation email
   * over the network. Held inside `TenantContextInterceptor`'s single request
   * transaction that meant one pooled connection for the whole run (backend §4
   * forbids exactly this) and, worse, one rollback boundary around it: a
   * failure at row 3000 discarded 3000 envelope rows while their 3000 emails
   * stayed in recipients' inboxes, linking to envelopes that no longer existed.
   *
   * Opting out alone would be a different bug — the interceptor skips tenant
   * setup entirely, so there is no `app.current_org_id` GUC and RLS denies
   * every query. `createJob` therefore opens its own transactions, one per row,
   * via `runInNewTenantTransaction`.
   */
  @Post("jobs")
  @HttpCode(201)
  @NoTenantTransaction()
  @Idempotent("sign:bulk_send.create")
  @RequirePermission("sign:bulk_send:run")
  @Validate({ body: createBulkSendJobSchema })
  create(@Body() body: CreateBulkSendJobInput, @CurrentUser() u: CurrentUserContext) {
    return this.bulkSend.createJob(u.orgId, actingMembershipId(u.principal), body);
  }

  @Get("jobs")
  @RequirePermission("sign:bulk_send:run")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.bulkSend.listJobs(u.orgId);
  }

  @Get("jobs/:jobId")
  @RequirePermission("sign:bulk_send:run")
  @Validate({ params: jobIdParams })
  get(@Param("jobId", ParseIntPipe) jobId: number, @CurrentUser() u: CurrentUserContext) {
    return this.bulkSend.getJob(u.orgId, jobId);
  }

  @Post("jobs/:jobId/cancel")
  @BodylessAction()
  @RequirePermission("sign:bulk_send:run")
  @Validate({ params: jobIdParams })
  cancel(@Param("jobId", ParseIntPipe) jobId: number, @CurrentUser() u: CurrentUserContext) {
    return this.bulkSend.cancel(u.orgId, jobId, { userId: u.userId });
  }

  @Get("jobs/:jobId/error-report")
  @RequirePermission("sign:bulk_send:run")
  @Validate({ params: jobIdParams })
  errorReport(@Param("jobId", ParseIntPipe) jobId: number, @CurrentUser() u: CurrentUserContext) {
    return this.bulkSend.getErrorReport(u.orgId, jobId);
  }
}
