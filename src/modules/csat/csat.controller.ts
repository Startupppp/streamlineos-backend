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
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { Public } from "../../common/auth/public.decorator";
import { RateLimitGuard } from "../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
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
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  csatSurveyListSchema,
  csatSurveyDetailSchema,
  csatSurveyRowSchema,
  csatResponseListSchema,
  csatSubmittedSchema,
  successSchema,
} from "./dto/csat-response.schemas";

const surveyIdParams = z.object({ surveyId: z.coerce.number().int().positive() }).strict();

@RequireModule("support")
@Controller("csat")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CsatController {
  constructor(private readonly csat: CsatService) {}

  @Get()
  @RequirePermission("support:csat:view")
  @ResponseSchema(csatSurveyListSchema)
  list(@CurrentUser() u: CurrentUserContext) {
    return this.csat.listSurveys(u.orgId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("support:csat:manage")
  @Validate({ body: createSchema })
  @ResponseSchema(csatSurveyRowSchema)
  create(
    @Body() body: CreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.csat.createSurvey(u.orgId, u.userId, body);
  }

  @Get(":surveyId")
  @RequirePermission("support:csat:view")
  @Validate({ params: surveyIdParams })
  @ResponseSchema(csatSurveyDetailSchema)
  async get(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const survey = await this.csat.getSurvey(u.orgId, surveyId);
    if (!survey) throw new NotFoundException("Survey not found");
    return survey;
  }

  @Patch(":surveyId")
  @RequirePermission("support:csat:manage")
  @Validate({ params: surveyIdParams, body: patchSchema })
  @ResponseSchema(csatSurveyRowSchema)
  async update(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Body() body: PatchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.csat.updateSurvey(u.orgId, surveyId, body);
    if (!updated) throw new NotFoundException("Survey not found");
    return updated;
  }

  @Delete(":surveyId")
  @RequirePermission("support:csat:manage")
  @Validate({ params: surveyIdParams })
  @ResponseSchema(successSchema)
  async remove(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.csat.deleteSurvey(u.orgId, surveyId);
    if (!result) throw new NotFoundException("Survey not found");
    return result;
  }

  @Get(":surveyId/responses")
  @RequirePermission("support:csat:view")
  @Validate({ params: surveyIdParams, query: listResponsesSchema })
  @ResponseSchema(csatResponseListSchema)
  async listResponses(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Query() query: ListResponsesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const responses = await this.csat.listResponses(u.orgId, surveyId, query.limit);
    if (!responses) throw new NotFoundException("Survey not found");
    return responses;
  }

  @Public()
  @Post(":surveyId/responses")
  @HttpCode(201)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("csat:submit")
  @Validate({ params: surveyIdParams, body: submitResponseSchema })
  @ResponseSchema(csatSubmittedSchema)
  async submitResponse(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Body() body: SubmitResponseInput,
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
