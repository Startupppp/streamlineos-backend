import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
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
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("hr")
@Controller("hr/certifications")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrCertificationsController {
  constructor(private readonly competencies: HrCompetenciesService) {}

  @Get()
  @RequirePermission("hr:employees:view")
  list(
    @Query(new ZodValidationPipe(certificationListQuerySchema)) query: CertificationListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.competencies.listCertifications(u.orgId, query);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:employees:manage")
  create(
    @Body(new ZodValidationPipe(createCertificationSchema)) body: CreateCertificationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.competencies.createCertification(u.orgId, u.userId, body);
  }
}
