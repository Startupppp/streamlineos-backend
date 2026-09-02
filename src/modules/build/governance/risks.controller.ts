import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RisksService } from "./risks.service";
import {
  createRiskSchema,
  listRisksQuerySchema,
  updateRiskSchema,
  type CreateRiskInput,
  type ListRisksQuery,
  type UpdateRiskInput,
} from "./dto/governance.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const riskIdParams = z.object({ riskId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build/:projectId/risks")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RisksController {
  constructor(private readonly svc: RisksService) {}

  @Get()
  @RequirePermission("build:risks:view")
  @Validate({ query: listRisksQuerySchema })
  listRisks(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query() query: ListRisksQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listRisks(u, projectId, query);
  }

  @Get(":riskId")
  @RequirePermission("build:risks:view")
  @Validate({ params: riskIdParams })
  getRisk(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("riskId", ParseIntPipe) riskId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getRisk(u, projectId, riskId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:risks:manage")
  @Validate({ body: createRiskSchema })
  createRisk(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: CreateRiskInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createRisk(u, projectId, body);
  }

  @Patch(":riskId")
  @RequirePermission("build:risks:manage")
  @Validate({ params: riskIdParams, body: updateRiskSchema })
  updateRisk(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("riskId", ParseIntPipe) riskId: number,
    @Body() body: UpdateRiskInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateRisk(u, projectId, riskId, body);
  }

  @Delete(":riskId")
  @RequirePermission("build:risks:manage")
  @HttpCode(204)
  @Validate({ params: riskIdParams })
  softDeleteRisk(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("riskId", ParseIntPipe) riskId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.softDeleteRisk(u, projectId, riskId);
  }
}
