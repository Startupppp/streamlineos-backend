import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Validate } from "../../common/validation/validate.decorator";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  surveyParticipantListSchema,
  surveyImportResultSchema,
  surveyInviteResultSchema,
  surveyRemindResultSchema,
} from "./dto/survey-participants-response.schemas";
import { SurveyParticipantService } from "./survey-participant.service";
import {
  importParticipantsSchema,
  inviteParticipantsSchema,
  remindParticipantsSchema,
  listParticipantsSchema,
  type ImportParticipantsInput,
  type InviteParticipantsInput,
  type RemindParticipantsInput,
  type ListParticipantsInput,
} from "./dto/survey-participants.schemas";

const surveyIdParams = z.object({ surveyId: z.coerce.number().int().positive() }).strict();

@RequireModule("surveys")
@Controller("surveys/:surveyId/participants")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SurveyParticipantsController {
  constructor(private readonly participants: SurveyParticipantService) {}

  @Get()
  @RequirePermission("surveys:participants:view")
  @Validate({ params: surveyIdParams, query: listParticipantsSchema })
  @ResponseSchema(surveyParticipantListSchema)
  list(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Query() query: ListParticipantsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.participants.list(u.orgId, surveyId, query);
  }

  @Post("import")
  @HttpCode(201)
  @RequirePermission("surveys:participants:manage")
  @Validate({ params: surveyIdParams, body: importParticipantsSchema })
  @ResponseSchema(surveyImportResultSchema)
  import(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Body() body: ImportParticipantsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.participants.import(u.orgId, surveyId, body);
  }

  @Post("invite")
  @Idempotent("surveys.participants.invite")
  @HttpCode(200)
  @RequirePermission("surveys:participants:manage")
  @Validate({ params: surveyIdParams, body: inviteParticipantsSchema })
  @ResponseSchema(surveyInviteResultSchema)
  invite(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Body() body: InviteParticipantsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.participants.invite(u.orgId, surveyId, body.participantIds);
  }

  @Post("remind")
  @Idempotent("surveys.participants.remind")
  @HttpCode(200)
  @RequirePermission("surveys:participants:manage")
  @Validate({ params: surveyIdParams, body: remindParticipantsSchema })
  @ResponseSchema(surveyRemindResultSchema)
  remind(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Body() body: RemindParticipantsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.participants.remind(u.orgId, surveyId, body.participantIds);
  }
}
