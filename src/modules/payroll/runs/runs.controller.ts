import {
  Controller,
  Get,
  HttpCode,
  Post,
  Body,
  Param,
  ParseIntPipe,
  Query,
  Headers,
  UseGuards,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { resolvePayrollRunsViewScope } from "../payroll-scope";
import { RunsService } from "./runs.service";
import { GenerateService } from "./generate.service";
import { PayrollCommandReceiptsService } from "../command-receipts.service";
import {
  createRunSchema,
  listRunsQuerySchema,
  listRunEmployeesQuerySchema,
  setEmployeeHoldSchema,
  addRunAdjustmentSchema,
  type CreateRunInput,
  type ListRunsQuery,
  type ListRunEmployeesQuery,
  type SetEmployeeHoldInput,
  type AddRunAdjustmentInput,
} from "./dto/runs.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const runIdParams = z.object({ runId: z.coerce.number().int().positive() }).strict();
const runIdrunEmployeeIdParams = z.object({ runId: z.coerce.number().int().positive(), runEmployeeId: z.coerce.number().int().positive() }).strict();

@RequireModule("payroll")
@Controller("payroll/runs")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class RunsController {
  constructor(
    private readonly runsService: RunsService,
    private readonly generateService: GenerateService,
    private readonly access: AccessService,
    private readonly receipts: PayrollCommandReceiptsService,
  ) {}

  @Post()
  @HttpCode(201)
  @RequirePermission("payroll:runs:create")
  @Validate({ body: createRunSchema })
  async create(
    @Body() body: CreateRunInput,
    @CurrentUser() u: CurrentUserContext,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    const key = idempotencyKey?.trim() || `run.create:${u.orgId}:${body.month}`;
    const begin = await this.receipts.begin({
      orgId: u.orgId,
      command: "run.create",
      idempotencyKey: key,
      actorId: u.userId,
      requestHash: this.receipts.hashRequest(body),
    });
    if (begin.kind === "replay") return begin.response;
    if (begin.kind === "inflight") {
      throw new ConflictException("Run creation already in progress for this key");
    }

    try {
      const result = await this.runsService.createRun(u.orgId, u.userId, body.month, {
        runType: body.runType,
        sourcePeriodKey: body.sourcePeriodKey,
        sourceRunId: body.sourceRunId,
        entityId: body.entityId,
      });
      if (!result.ok) {
        const entitySuffix =
          body.entityId != null ? ` for entity ${body.entityId}` : " (org-level, no entity)";
        const msg = `A ${body.runType ?? "REGULAR"} payroll run for this month already exists${entitySuffix}`;
        await this.receipts.fail(begin.receiptId, msg);
        throw new ConflictException(msg);
      }

      const generated = await this.generateService.generateRun(u.orgId, result.runId, u.userId, false);
      const response =
        generated.ok
          ? { runId: result.runId, correlationId: begin.correlationId }
          : {
              runId: result.runId,
              warning: `Run created but generation failed: ${generated.reason}`,
              correlationId: begin.correlationId,
            };
      await this.receipts.succeed(begin.receiptId, response);
      return response;
    } catch (err) {
      if (!(err instanceof ConflictException)) {
        await this.receipts.fail(
          begin.receiptId,
          err instanceof Error ? err.message : "run.create failed",
        );
      }
      throw err;
    }
  }

  @Get()
  @RequirePermission("payroll:runs:view")
  @Validate({ query: listRunsQuerySchema })
  async list(
    @Query() query: ListRunsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.runsService.listRuns(u.orgId, query);
  }

  @Get(":runId")
  @RequirePermission("payroll:runs:view")
  @Validate({ params: runIdParams })
  async getOne(
    @Param("runId", ParseIntPipe) runId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.runsService.getRunById(u.orgId, runId);
    if (!result) throw new NotFoundException("Payroll run not found");
    return result;
  }

  @Post(":runId/generate")
  @HttpCode(200)
  @RequirePermission("payroll:runs:manage")
  @Validate({ params: runIdParams })
  async generate(
    @Param("runId", ParseIntPipe) runId: number,
    @CurrentUser() u: CurrentUserContext,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return this.runGenerateCommand(u, runId, false, idempotencyKey);
  }

  @Post(":runId/recalculate")
  @HttpCode(200)
  @RequirePermission("payroll:runs:manage")
  @Validate({ params: runIdParams })
  async recalculate(
    @Param("runId", ParseIntPipe) runId: number,
    @CurrentUser() u: CurrentUserContext,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return this.runGenerateCommand(u, runId, true, idempotencyKey);
  }

  private async runGenerateCommand(
    u: CurrentUserContext,
    runId: number,
    isRecalc: boolean,
    idempotencyKey: string | undefined,
  ) {
    const command = isRecalc ? "run.recalculate" : "run.generate";
    const key = idempotencyKey?.trim() || `${command}:${u.orgId}:${runId}`;
    const begin = await this.receipts.begin({
      orgId: u.orgId,
      command,
      idempotencyKey: key,
      actorId: u.userId,
      runId,
    });
    if (begin.kind === "replay") return begin.response;
    if (begin.kind === "inflight") {
      throw new ConflictException("Generation already in progress for this key");
    }

    try {
      const result = await this.generateService.generateRun(u.orgId, runId, u.userId, isRecalc);
      if (!result.ok) {
        await this.receipts.fail(begin.receiptId, result.reason);
        if (result.reason === "not_found") throw new NotFoundException("Payroll run not found");
        if (result.reason === "locked") {
          throw new BadRequestException(
            isRecalc ? "Cannot recalculate a locked run" : "Cannot generate a locked run",
          );
        }
        if (result.reason === "generation_in_progress") {
          throw new ConflictException("Payroll run is already being generated or recalculated");
        }
        throw new BadRequestException(result.reason);
      }
      const response = { ok: true, correlationId: begin.correlationId };
      await this.receipts.succeed(begin.receiptId, response);
      return response;
    } catch (err) {
      // fail already called on known result.ok=false paths; catch unexpected
      if (!(err instanceof NotFoundException || err instanceof BadRequestException || err instanceof ConflictException)) {
        await this.receipts.fail(begin.receiptId, err instanceof Error ? err.message : "generate failed");
      }
      throw err;
    }
  }

  @Get(":runId/employees")
  @RequirePermission("payroll:runs:view")
  @Validate({ params: runIdParams, query: listRunEmployeesQuerySchema })
  async listEmployees(
    @Param("runId", ParseIntPipe) runId: number,
    @Query() query: ListRunEmployeesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolvePayrollRunsViewScope(this.access, u);
    const result = await this.runsService.listRunEmployees(u.orgId, runId, query, scope, u.userId);
    if (!result) throw new NotFoundException("Payroll run not found");
    return result;
  }

  @Get(":runId/employees/:runEmployeeId")
  @RequirePermission("payroll:runs:view")
  @Validate({ params: runIdrunEmployeeIdParams })
  async getEmployee(
    @Param("runId", ParseIntPipe) runId: number,
    @Param("runEmployeeId", ParseIntPipe) runEmployeeId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.runsService.getRunEmployee(u.orgId, runId, runEmployeeId);
    if (!result) throw new NotFoundException("Employee record not found in this run");
    return result;
  }

  @Post(":runId/employees/:runEmployeeId/adjustments")
  @HttpCode(201)
  @RequirePermission("payroll:runs:manage")
  @Validate({ params: runIdrunEmployeeIdParams, body: addRunAdjustmentSchema })
  async addAdjustment(
    @Param("runId", ParseIntPipe) runId: number,
    @Param("runEmployeeId", ParseIntPipe) runEmployeeId: number,
    @Body() body: AddRunAdjustmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.runsService.addRunAdjustment(u.orgId, runId, runEmployeeId, body, u.userId);
    if (!result.ok) {
      if (result.reason === "locked") throw new BadRequestException("Cannot add an adjustment to a locked payroll run");
      throw new NotFoundException("Employee record not found in this run");
    }
    return { ok: true };
  }

  @Post(":runId/employees/:runEmployeeId/hold")
  @HttpCode(200)
  @RequirePermission("payroll:runs:manage")
  @Validate({ params: runIdrunEmployeeIdParams, body: setEmployeeHoldSchema })
  async setEmployeeHold(
    @Param("runId", ParseIntPipe) runId: number,
    @Param("runEmployeeId", ParseIntPipe) runEmployeeId: number,
    @Body() body: SetEmployeeHoldInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.runsService.setEmployeeHold(
      u.orgId,
      runId,
      runEmployeeId,
      body.hold,
      body.reason ?? null,
      u.userId,
    );
    if (!result.ok) throw new NotFoundException("Employee record not found in this run");
    return { ok: true };
  }

  @Get(":runId/variance")
  @RequirePermission("payroll:runs:view")
  @Validate({ params: runIdParams })
  async variance(
    @Param("runId", ParseIntPipe) runId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.runsService.getVariance(u.orgId, runId);
    if (!result) throw new NotFoundException("Payroll run not found");
    return result;
  }
}
