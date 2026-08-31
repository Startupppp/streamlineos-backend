import {
  Controller,
  Get,
  Patch,
  Body,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
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
import { ExceptionsService } from "./exceptions.service";
import {
  resolveExceptionSchema,
  overrideExceptionSchema,
  exceptionFilterSchema,
  type ResolveExceptionInput,
  type OverrideExceptionInput,
  type ExceptionFilterInput,
} from "./dto/runs.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const runIdParams = z.object({ runId: z.coerce.number().int().positive() }).strict();
const runAndExceptionIdParams = z.object({ runId: z.coerce.number().int().positive(), exceptionId: z.coerce.number().int().positive() }).strict();

@RequireModule("payroll")
@Controller("payroll/runs/:runId/exceptions")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class ExceptionsController {
  constructor(private readonly exceptionsService: ExceptionsService) {}

  @Get()
  @RequirePermission("payroll:runs:view")
  @Validate({ params: runIdParams, query: exceptionFilterSchema })
  async list(
    @Param("runId", ParseIntPipe) runId: number,
    @Query() query: ExceptionFilterInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.exceptionsService.listExceptions(u.orgId, runId, query.severity, query.status, query.page, query.limit);
    if (!result) throw new NotFoundException("Payroll run not found");
    return result;
  }

  @Patch(":exceptionId/resolve")
  @RequirePermission("payroll:runs:update")
  @Validate({ params: runAndExceptionIdParams, body: resolveExceptionSchema })
  async resolve(
    @Param("runId", ParseIntPipe) runId: number,
    @Param("exceptionId", ParseIntPipe) exceptionId: number,
    @Body() body: ResolveExceptionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.exceptionsService.resolveException(u.orgId, runId, exceptionId, u.userId, body);
    if (!result.ok) {
      if (result.reason === "not_found" || result.reason === "exception_not_found") throw new NotFoundException("Not found");
      if (result.reason === "locked") throw new BadRequestException("Cannot modify a locked run");
      if (result.reason === "already_resolved") throw new BadRequestException("Exception is already resolved");
      throw new BadRequestException(result.reason);
    }
    return { ok: true };
  }

  @Patch(":exceptionId/override")
  @RequirePermission("payroll:runs:manage")
  @Validate({ params: runAndExceptionIdParams, body: overrideExceptionSchema })
  async override(
    @Param("runId", ParseIntPipe) runId: number,
    @Param("exceptionId", ParseIntPipe) exceptionId: number,
    @Body() body: OverrideExceptionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.exceptionsService.overrideException(u.orgId, runId, exceptionId, u.userId, body);
    if (!result.ok) {
      if (result.reason === "not_found" || result.reason === "exception_not_found") throw new NotFoundException("Not found");
      if (result.reason === "locked") throw new BadRequestException("Cannot modify a locked run");
      if (result.reason === "already_resolved") throw new BadRequestException("Exception is already resolved or overridden");
      throw new BadRequestException(result.reason);
    }
    return { ok: true };
  }
}
