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
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrHiringFlowsService } from "./hr-hiring-flows.service";
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

@Controller("hr/recruitment/hiring-flows")
@UseGuards(JwtAuthGuard)
export class HrHiringFlowsController {
  constructor(private readonly flows: HrHiringFlowsService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(hiringFlowListSchema)) query: HiringFlowListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.flows.listFlows(u.orgId, query.limit, query.offset);
  }

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createHiringFlowSchema)) body: CreateHiringFlowInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.flows.createFlow(u.orgId, u.userId, body);
  }

  @Get(":flowId")
  getOne(
    @Param("flowId", ParseIntPipe) flowId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.flows.getFlow(u.orgId, flowId);
  }

  @Patch(":flowId")
  update(
    @Param("flowId", ParseIntPipe) flowId: number,
    @Body(new ZodValidationPipe(updateHiringFlowSchema)) body: UpdateHiringFlowInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.flows.updateFlow(u.orgId, flowId, body);
  }

  @Delete(":flowId")
  remove(
    @Param("flowId", ParseIntPipe) flowId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.flows.deleteFlow(u.orgId, flowId);
  }

  @Get(":flowId/rounds")
  listRounds(
    @Param("flowId", ParseIntPipe) flowId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.flows.listRounds(u.orgId, flowId);
  }

  @Post(":flowId/rounds")
  @HttpCode(201)
  createRound(
    @Param("flowId", ParseIntPipe) flowId: number,
    @Body(new ZodValidationPipe(createRoundSchema)) body: CreateRoundInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.flows.createRound(u.orgId, flowId, body);
  }

  @Patch(":flowId/rounds/:roundId")
  updateRound(
    @Param("flowId", ParseIntPipe) flowId: number,
    @Param("roundId", ParseIntPipe) roundId: number,
    @Body(new ZodValidationPipe(updateRoundSchema)) body: UpdateRoundInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.flows.updateRound(u.orgId, flowId, roundId, body);
  }

  @Delete(":flowId/rounds/:roundId")
  removeRound(
    @Param("flowId", ParseIntPipe) flowId: number,
    @Param("roundId", ParseIntPipe) roundId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.flows.deleteRound(u.orgId, flowId, roundId);
  }
}
