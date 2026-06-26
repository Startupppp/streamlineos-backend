import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrCompetenciesService } from "./hr-competencies.service";
import {
  certificationListQuerySchema,
  createCertificationSchema,
  type CertificationListQuery,
  type CreateCertificationInput,
} from "./dto/competencies.schemas";

@Controller("hr/certifications")
@UseGuards(JwtAuthGuard)
export class HrCertificationsController {
  constructor(private readonly competencies: HrCompetenciesService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(certificationListQuerySchema)) query: CertificationListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.competencies.listCertifications(u.orgId, query);
  }

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createCertificationSchema)) body: CreateCertificationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.competencies.createCertification(u.orgId, u.userId, body);
  }
}
