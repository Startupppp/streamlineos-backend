import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { Public } from "../../common/auth/public.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  CsatService,
  isSubmitNotFound,
  isSubmitOutOfRange,
} from "./csat.service";
import {
  createSchema,
  listResponsesSchema,
  patchSchema,
  submitResponseSchema,
  type CreateInput,
  type ListResponsesInput,
  type PatchInput,
  type SubmitResponseInput,
} from "./dto/csat.schemas";

@Controller("csat")
@UseGuards(JwtAuthGuard)
export class CsatController {
  constructor(private readonly csat: CsatService) {}

  @Get()
  list(@CurrentUser() u: CurrentUserContext) {
    return this.csat.listSurveys(u.orgId);
  }

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createSchema)) body: CreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.csat.createSurvey(u.orgId, u.userId, body);
  }

  @Get(":surveyId")
  async get(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const survey = await this.csat.getSurvey(u.orgId, surveyId);
    if (!survey) throw new NotFoundException("Survey not found");
    return survey;
  }

  @Patch(":surveyId")
  async update(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Body(new ZodValidationPipe(patchSchema)) body: PatchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.csat.updateSurvey(u.orgId, surveyId, body);
    if (!updated) throw new NotFoundException("Survey not found");
    return updated;
  }

  @Delete(":surveyId")
  async remove(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.csat.deleteSurvey(u.orgId, surveyId);
    if (!result) throw new NotFoundException("Survey not found");
    return result;
  }

  @Get(":surveyId/responses")
  async listResponses(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Query(new ZodValidationPipe(listResponsesSchema)) query: ListResponsesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const responses = await this.csat.listResponses(u.orgId, surveyId, query.limit);
    if (!responses) throw new NotFoundException("Survey not found");
    return responses;
  }

  @Public()
  @Post(":surveyId/responses")
  @HttpCode(201)
  async submitResponse(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Body(new ZodValidationPipe(submitResponseSchema)) body: SubmitResponseInput,
  ) {
    const result = await this.csat.submitResponse(surveyId, body);
    if (isSubmitNotFound(result)) {
      throw new NotFoundException("Survey not found or not active");
    }
    if (isSubmitOutOfRange(result)) {
      throw new BadRequestException(
        `Rating must be between 1 and ${result.scaleMax}`,
      );
    }
    return result;
  }
}
