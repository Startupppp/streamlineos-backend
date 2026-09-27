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
import { orgListRisksQuerySchema, type OrgListRisksQuery } from "./dto/org-governance.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import {
  NoContentResponse,
  ResponseSchema,
} from "../../../common/openapi/zod-operation-contracts";
import { riskPageSchema, riskRowSchema, riskStatsSchema } from "./dto/governance-response.schemas";

export const riskIdParams = z
  .object({
    projectId: z.coerce.number().int().positive(),
    riskId: z.coerce.number().int().positive(),
  })
  .strict();

@RequireModule("build")
@Controller("build")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RisksController {
  constructor(private readonly svc: RisksService) {}

  @Get("risks")
  @RequirePermission("build:risks:view")
  @ResponseSchema(riskPageSchema)
  @Validate({ query: orgListRisksQuerySchema })
  listOrgRisks(@CurrentUser() u: CurrentUserContext, @Query() query: OrgListRisksQuery) {
    return this.svc.listOrgRisks(u, query);
  }

  @Get(":projectId/risks")
  @RequirePermission("build:risks:view")
  @ResponseSchema(riskPageSchema)
  @Validate({ query: listRisksQuerySchema })
  listRisks(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query() query: ListRisksQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listRisks(u, projectId, query);
  }

  @Get(":projectId/risks/stats")
  @RequirePermission("build:risks:view")
  @ResponseSchema(riskStatsSchema)
  getRiskStats(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getRiskStats(u, projectId);
  }

  @Get(":projectId/risks/:riskId")
  @RequirePermission("build:risks:view")
  @ResponseSchema(riskRowSchema)
  @Validate({ params: riskIdParams })
  getRisk(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("riskId", ParseIntPipe) riskId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getRisk(u, projectId, riskId);
  }

  @Post(":projectId/risks")
  @HttpCode(201)
  @RequirePermission("build:risks:manage")
  @ResponseSchema(riskRowSchema)
  @Validate({ body: createRiskSchema })
  createRisk(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: CreateRiskInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createRisk(u, projectId, body);
  }

  @Patch(":projectId/risks/:riskId")
  @RequirePermission("build:risks:manage")
  @ResponseSchema(riskRowSchema)
  @Validate({ params: riskIdParams, body: updateRiskSchema })
  updateRisk(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("riskId", ParseIntPipe) riskId: number,
    @Body() body: UpdateRiskInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateRisk(u, projectId, riskId, body);
  }

  @Delete(":projectId/risks/:riskId")
  @RequirePermission("build:risks:manage")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: riskIdParams })
  softDeleteRisk(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("riskId", ParseIntPipe) riskId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.softDeleteRisk(u, projectId, riskId);
  }
}
