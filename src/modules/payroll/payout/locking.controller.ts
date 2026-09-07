import {
  Body,
  ConflictException,
  Controller,
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
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { lockResponseSchema, reopenResponseSchema, closeResponseSchema } from "./dto/payout-response.schemas";
import { z } from "zod";
import { LockingService } from "./locking.service";
import { reopenRunSchema, type ReopenRunInput } from "./dto/payout.schemas";
import { PayrollCommandReceiptsService } from "../command-receipts.service";

const runIdParams = z.object({ runId: z.coerce.number().int().positive() }).strict();

@RequireModule("payroll")
@Controller("payroll/runs/:runId")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class LockingController {
  constructor(
    private readonly locking: LockingService,
    private readonly receipts: PayrollCommandReceiptsService,
  ) {}

  @Post("lock")
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("payroll:runs:manage")
  @Validate({ params: runIdParams })
  @ResponseSchema(lockResponseSchema)
  async lock(
    @Param("runId", ParseIntPipe) runId: number,
    @CurrentUser() u: CurrentUserContext,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return this.withReceipt(u, runId, "run.lock", idempotencyKey, () =>
      this.locking.lock(u.orgId, u.userId, runId),
    );
  }

  @Post("reopen")
  @HttpCode(200)
  @RequirePermission("payroll:runs:manage")
  @Validate({ params: runIdParams, body: reopenRunSchema })
  @ResponseSchema(reopenResponseSchema)
  async reopen(
    @Param("runId", ParseIntPipe) runId: number,
    @Body() body: ReopenRunInput,
    @CurrentUser() u: CurrentUserContext,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return this.withReceipt(
      u,
      runId,
      "run.reopen",
      idempotencyKey ?? `run.reopen:${u.orgId}:${runId}:${body.reason}`,
      () => this.locking.reopen(u.orgId, u.userId, runId, body.reason),
      body,
    );
  }

  @Post("close")
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("payroll:runs:manage")
  @Validate({ params: runIdParams })
  @ResponseSchema(closeResponseSchema)
  async close(
    @Param("runId", ParseIntPipe) runId: number,
    @CurrentUser() u: CurrentUserContext,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return this.withReceipt(u, runId, "run.close", idempotencyKey, () =>
      this.locking.close(u.orgId, u.userId, runId),
    );
  }

  private async withReceipt(
    u: CurrentUserContext,
    runId: number,
    command: "run.lock" | "run.reopen" | "run.close",
    idempotencyKey: string | undefined,
    fn: () => Promise<unknown>,
    body?: unknown,
  ) {
    const key = idempotencyKey?.trim() || `${command}:${u.orgId}:${runId}`;
    const begin = await this.receipts.begin({
      orgId: u.orgId,
      command,
      idempotencyKey: key,
      actorId: u.userId,
      runId,
      requestHash: this.receipts.hashRequest(body ?? null),
    });
    if (begin.kind === "replay") return begin.response;
    if (begin.kind === "inflight") {
      throw new ConflictException("Command already in progress for this key");
    }
    try {
      const result = await fn();
      const response = { ...(result as object), correlationId: begin.correlationId };
      await this.receipts.succeed(begin.receiptId, response);
      return response;
    } catch (err) {
      await this.receipts.fail(
        begin.receiptId,
        err instanceof Error ? err.message : `${command} failed`,
      );
      throw err;
    }
  }
}
