import {
  Controller,
  Get,
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
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { InputsService } from "./inputs.service";
import {
  patchInputSchema,
  inputsQuerySchema,
  type PatchInputInput,
  type InputsQuery,
} from "./dto/runs.schemas";

@Controller("payroll/runs/:runId/inputs")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class InputsController {
  constructor(private readonly inputsService: InputsService) {}

  @Get()
  @RequirePermission("payroll:runs:view")
  async list(
    @Param("runId", ParseIntPipe) runId: number,
    @Query(new ZodValidationPipe(inputsQuerySchema)) query: InputsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.inputsService.listInputs(u.orgId, runId, query);
    if (!result) throw new NotFoundException("Payroll run not found");
    return result;
  }

  @Patch(":inputId")
  @RequirePermission("payroll:runs:update")
  async patchInput(
    @Param("runId", ParseIntPipe) runId: number,
    @Param("inputId", ParseIntPipe) inputId: number,
    @Body(new ZodValidationPipe(patchInputSchema)) body: PatchInputInput,
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
  @RequirePermission("payroll:runs:update")
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
