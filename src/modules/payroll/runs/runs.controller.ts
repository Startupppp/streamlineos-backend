import {
  Controller,
  Get,
  HttpCode,
  Post,
  Body,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { AccessService } from "../../access/access.service";
import { resolvePayrollRunsViewScope } from "../payroll-scope";
import { RunsService } from "./runs.service";
import { GenerateService } from "./generate.service";
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

@Controller("payroll/runs")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RunsController {
  constructor(
    private readonly runsService: RunsService,
    private readonly generateService: GenerateService,
    private readonly access: AccessService,
  ) {}

  @Post()
  @HttpCode(201)
  @RequirePermission("payroll:runs:update")
  async create(
    @Body(new ZodValidationPipe(createRunSchema)) body: CreateRunInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.runsService.createRun(u.orgId, u.userId, body.month);
    if (!result.ok) throw new ConflictException("A payroll run for this month already exists");

    const generated = await this.generateService.generateRun(u.orgId, result.runId, u.userId, false);
    if (!generated.ok) {
      return { runId: result.runId, warning: `Run created but generation failed: ${generated.reason}` };
    }

    return { runId: result.runId };
  }

  @Get()
  @RequirePermission("payroll:runs:view")
  async list(
    @Query(new ZodValidationPipe(listRunsQuerySchema)) query: ListRunsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.runsService.listRuns(u.orgId, query);
  }

  @Get("current")
  @RequirePermission("payroll:runs:view")
  async getCurrent(@CurrentUser() u: CurrentUserContext) {
    const run = await this.runsService.getCurrentRun(u.orgId);
    if (!run) throw new NotFoundException("No payroll run found");
    return run;
  }

  @Get(":runId")
  @RequirePermission("payroll:runs:view")
  async getOne(
    @Param("runId", ParseIntPipe) runId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.runsService.getRunById(u.orgId, runId);
    if (!result) throw new NotFoundException("Payroll run not found");
    return result;
  }

  @Post(":runId/generate")
  @RequirePermission("payroll:runs:manage")
  async generate(
    @Param("runId", ParseIntPipe) runId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.generateService.generateRun(u.orgId, runId, u.userId, false);
    if (!result.ok) {
      if (result.reason === "not_found") throw new NotFoundException("Payroll run not found");
      if (result.reason === "locked") throw new BadRequestException("Cannot generate a locked run");
      throw new BadRequestException(result.reason);
    }
    return { ok: true };
  }

  @Post(":runId/recalculate")
  @RequirePermission("payroll:runs:manage")
  async recalculate(
    @Param("runId", ParseIntPipe) runId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.generateService.generateRun(u.orgId, runId, u.userId, true);
    if (!result.ok) {
      if (result.reason === "not_found") throw new NotFoundException("Payroll run not found");
      if (result.reason === "locked") throw new BadRequestException("Cannot recalculate a locked run");
      throw new BadRequestException(result.reason);
    }
    return { ok: true };
  }

  @Get(":runId/employees")
  @RequirePermission("payroll:runs:view")
  async listEmployees(
    @Param("runId", ParseIntPipe) runId: number,
    @Query(new ZodValidationPipe(listRunEmployeesQuerySchema)) query: ListRunEmployeesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolvePayrollRunsViewScope(this.access, u);
    const result = await this.runsService.listRunEmployees(u.orgId, runId, query, scope, u.userId);
    if (!result) throw new NotFoundException("Payroll run not found");
    return result;
  }

  @Get(":runId/employees/:runEmployeeId")
  @RequirePermission("payroll:runs:view")
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
  @RequirePermission("payroll:runs:manage")
  async addAdjustment(
    @Param("runId", ParseIntPipe) runId: number,
    @Param("runEmployeeId", ParseIntPipe) runEmployeeId: number,
    @Body(new ZodValidationPipe(addRunAdjustmentSchema)) body: AddRunAdjustmentInput,
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
  @RequirePermission("payroll:runs:manage")
  async setEmployeeHold(
    @Param("runId", ParseIntPipe) runId: number,
    @Param("runEmployeeId", ParseIntPipe) runEmployeeId: number,
    @Body(new ZodValidationPipe(setEmployeeHoldSchema)) body: SetEmployeeHoldInput,
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
  async variance(
    @Param("runId", ParseIntPipe) runId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.runsService.getVariance(u.orgId, runId);
    if (!result) throw new NotFoundException("Payroll run not found");
    return result;
  }
}
