import {
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
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
import { ApprovalsService } from "./approvals.service";
import { PayrollCommandReceiptsService } from "../command-receipts.service";
import {
  approvalActionSchema,
  rejectActionSchema,
  type ApprovalActionInput,
  type RejectActionInput,
} from "./dto/payout.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const runIdParams = z.object({ runId: z.coerce.number().int().positive() }).strict();
const runAndApprovalIdParams = z.object({ runId: z.coerce.number().int().positive(), approvalId: z.coerce.number().int().positive() }).strict();

@RequireModule("payroll")
@Controller("payroll/runs/:runId")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class PayrollPayoutApprovalsController {
  constructor(
    private readonly approvals: ApprovalsService,
    private readonly receipts: PayrollCommandReceiptsService,
  ) {}

  @Post("submit-approval")
  @HttpCode(200)
  @RequirePermission("payroll:runs:update")
  @Validate({ params: runIdParams })
  async submitApproval(
    @Param("runId", ParseIntPipe) runId: number,
    @CurrentUser() u: CurrentUserContext,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    const key = idempotencyKey?.trim() || `run.submit_approval:${u.orgId}:${runId}`;
    const begin = await this.receipts.begin({
      orgId: u.orgId,
      command: "run.submit_approval",
      idempotencyKey: key,
      actorId: u.userId,
      runId,
    });
    if (begin.kind === "replay") return begin.response;
    if (begin.kind === "inflight") {
      throw new ConflictException("Approval submission already in progress for this key");
    }
    try {
      const result = await this.approvals.submitApproval(u.orgId, u.userId, runId, begin.correlationId);
      const response = { ...result, correlationId: begin.correlationId };
      await this.receipts.succeed(begin.receiptId, response);
      return response;
    } catch (err) {
      await this.receipts.fail(begin.receiptId, err instanceof Error ? err.message : "submit_approval failed");
      throw err;
    }
  }

  @Get("approvals")
  @RequirePermission("payroll:runs:view")
  @Validate({ params: runIdParams })
  listApprovals(
    @Param("runId", ParseIntPipe) runId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.approvals.listApprovals(u.orgId, runId, u.userId);
  }

  @Post("approvals/:approvalId/approve")
  @HttpCode(200)
  @RequirePermission("payroll:runs:approve")
  @Validate({ params: runAndApprovalIdParams, body: approvalActionSchema })
  async approveStage(
    @Param("runId", ParseIntPipe) runId: number,
    @Param("approvalId", ParseIntPipe) approvalId: number,
    @Body() body: ApprovalActionInput,
    @CurrentUser() u: CurrentUserContext,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    const key = idempotencyKey?.trim() || `run.approve_stage:${u.orgId}:${runId}:${approvalId}`;
    const begin = await this.receipts.begin({
      orgId: u.orgId,
      command: "run.approve_stage",
      idempotencyKey: key,
      actorId: u.userId,
      runId,
    });
    if (begin.kind === "replay") return begin.response;
    if (begin.kind === "inflight") {
      throw new ConflictException("Stage approval already in progress for this key");
    }
    try {
      const result = await this.approvals.approveStage(u.orgId, u.userId, runId, approvalId, body.comment, begin.correlationId);
      const response = { ...result, correlationId: begin.correlationId };
      await this.receipts.succeed(begin.receiptId, response);
      return response;
    } catch (err) {
      await this.receipts.fail(begin.receiptId, err instanceof Error ? err.message : "approve_stage failed");
      throw err;
    }
  }

  @Post("approvals/:approvalId/reject")
  @HttpCode(200)
  @RequirePermission("payroll:runs:approve")
  @Validate({ params: runAndApprovalIdParams, body: rejectActionSchema })
  async rejectStage(
    @Param("runId", ParseIntPipe) runId: number,
    @Param("approvalId", ParseIntPipe) approvalId: number,
    @Body() body: RejectActionInput,
    @CurrentUser() u: CurrentUserContext,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    const key = idempotencyKey?.trim() || `run.reject_stage:${u.orgId}:${runId}:${approvalId}`;
    const begin = await this.receipts.begin({
      orgId: u.orgId,
      command: "run.reject_stage",
      idempotencyKey: key,
      actorId: u.userId,
      runId,
    });
    if (begin.kind === "replay") return begin.response;
    if (begin.kind === "inflight") {
      throw new ConflictException("Stage rejection already in progress for this key");
    }
    try {
      const result = await this.approvals.rejectStage(u.orgId, u.userId, runId, approvalId, body.comment, begin.correlationId);
      const response = { ...result, correlationId: begin.correlationId };
      await this.receipts.succeed(begin.receiptId, response);
      return response;
    } catch (err) {
      await this.receipts.fail(begin.receiptId, err instanceof Error ? err.message : "reject_stage failed");
      throw err;
    }
  }
}
