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
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

import { HrHiringFlowsService } from "./hr-hiring-flows.service";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import {
  createHiringFlowSchema,
  createRoundSchema,
  hiringFlowListSchema,
  updateHiringFlowSchema,
  updateRoundSchema,
  type CreateHiringFlowInput,
  type CreateRoundInput,
  type HiringFlowListInput,
  type UpdateHiringFlowInput,
  type UpdateRoundInput,
} from "./dto/hr-interviews.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const flowIdParams = z.object({ flowId: z.coerce.number().int().positive() }).strict();
const flowIdroundIdParams = z.object({ flowId: z.coerce.number().int().positive(), roundId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/recruitment/hiring-flows")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrHiringFlowsController {
  constructor(private readonly flows: HrHiringFlowsService) {}

  @Get()
  @RequirePermission("hr:interviews:view")
  @Validate({ query: hiringFlowListSchema })
  list(
    @Query() query: HiringFlowListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.flows.listFlows(u.orgId, query.limit, query.offset);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:interviews:manage")
  @Validate({ body: createHiringFlowSchema })
  create(
    @Body() body: CreateHiringFlowInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.flows.createFlow(u.orgId, u.userId, body);
  }

  @Get(":flowId")
  @RequirePermission("hr:interviews:view")
  @Validate({ params: flowIdParams })
  getOne(
    @Param("flowId", ParseIntPipe) flowId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.flows.getFlow(u.orgId, flowId);
  }

  @Patch(":flowId")
  @RequirePermission("hr:interviews:manage")
  @Validate({ params: flowIdParams, body: updateHiringFlowSchema })
  update(
    @Param("flowId", ParseIntPipe) flowId: number,
    @Body() body: UpdateHiringFlowInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.flows.updateFlow(u.orgId, flowId, body);
  }

  @Delete(":flowId")
  @RequirePermission("hr:interviews:manage")
  @Validate({ params: flowIdParams })
  remove(
    @Param("flowId", ParseIntPipe) flowId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.flows.deleteFlow(u.orgId, flowId);
  }

  @Get(":flowId/rounds")
  @RequirePermission("hr:interviews:view")
  @Validate({ params: flowIdParams })
  listRounds(
    @Param("flowId", ParseIntPipe) flowId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.flows.listRounds(u.orgId, flowId);
  }

  @Post(":flowId/rounds")
  @HttpCode(201)
  @RequirePermission("hr:interviews:manage")
  @Validate({ params: flowIdParams, body: createRoundSchema })
  createRound(
    @Param("flowId", ParseIntPipe) flowId: number,
    @Body() body: CreateRoundInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.flows.createRound(u.orgId, flowId, body);
  }

  @Patch(":flowId/rounds/:roundId")
  @RequirePermission("hr:interviews:manage")
  @Validate({ params: flowIdroundIdParams, body: updateRoundSchema })
  updateRound(
    @Param("flowId", ParseIntPipe) flowId: number,
    @Param("roundId", ParseIntPipe) roundId: number,
    @Body() body: UpdateRoundInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.flows.updateRound(u.orgId, flowId, roundId, body);
  }

  @Delete(":flowId/rounds/:roundId")
  @RequirePermission("hr:interviews:manage")
  @Validate({ params: flowIdroundIdParams })
  removeRound(
    @Param("flowId", ParseIntPipe) flowId: number,
    @Param("roundId", ParseIntPipe) roundId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.flows.deleteRound(u.orgId, flowId, roundId);
  }
}
