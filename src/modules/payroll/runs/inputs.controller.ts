import {
  Controller,
  Get,
  HttpCode,
  Patch,
  Post,
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
import { AccessService } from "../../access/access.service";
import { resolvePayrollRunsViewScope } from "../payroll-scope";
import { InputsService } from "./inputs.service";
import {
  patchInputSchema,
  inputsQuerySchema,
  type PatchInputInput,
  type InputsQuery,
} from "./dto/runs.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";
import { z } from "zod";

const runIdParams = z.object({ runId: z.coerce.number().int().positive() }).strict();
const runAndInputIdParams = z.object({ runId: z.coerce.number().int().positive(), inputId: z.coerce.number().int().positive() }).strict();

@RequireModule("payroll")
@Controller("payroll/runs/:runId/inputs")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class InputsController {
  constructor(
    private readonly inputsService: InputsService,
    private readonly access: AccessService,
  ) {}

  @Get()
  @RequirePermission("payroll:runs:view")
  @Validate({ params: runIdParams, query: inputsQuerySchema })
  async list(
    @Param("runId", ParseIntPipe) runId: number,
    @Query() query: InputsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolvePayrollRunsViewScope(this.access, u);
    const result = await this.inputsService.listInputs(u.orgId, runId, query, scope, u.userId);
    if (!result) throw new NotFoundException("Payroll run not found");
    return result;
  }

  @Patch(":inputId")
  @RequirePermission("payroll:runs:update")
  @Validate({ params: runAndInputIdParams, body: patchInputSchema })
  async patchInput(
    @Param("runId", ParseIntPipe) runId: number,
    @Param("inputId", ParseIntPipe) inputId: number,
    @Body() body: PatchInputInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.inputsService.patchInput(u.orgId, runId, inputId, u.userId, body);
    if (!result.ok) {
      if (result.reason === "not_found" || result.reason === "input_not_found") throw new NotFoundException("Not found");
      if (result.reason === "locked") throw new BadRequestException("Cannot modify inputs on a locked run");
      throw new BadRequestException(result.reason);
    }
    return { ok: true };
  }

  @Post("reimport")
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("payroll:runs:update")
  @Validate({ params: runIdParams })
  async reimport(
    @Param("runId", ParseIntPipe) runId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.inputsService.reimportInputs(u.orgId, runId, u.userId);
    if (!result.ok) {
      if (result.reason === "not_found") throw new NotFoundException("Payroll run not found");
      if (result.reason === "locked") throw new BadRequestException("Cannot reimport inputs on a locked run");
      throw new BadRequestException(result.reason);
    }
    return { ok: true, count: result.count };
  }
}
