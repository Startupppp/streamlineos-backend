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
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { ComplianceRequirementsService } from "./compliance-requirements.service";
import {
  createComplianceRequirementSchema,
  updateComplianceRequirementSchema,
  listComplianceRequirementSchema,
  listComplianceEventsSchema,
  markEventDoneSchema,
  seedCountryPackSchema,
  type CreateComplianceRequirementInput,
  type UpdateComplianceRequirementInput,
  type ListComplianceRequirementInput,
  type ListComplianceEventsInput,
  type MarkEventDoneInput,
  type SeedCountryPackInput,
} from "./dto/hr-global.schemas";

@RequireModule("hr")
@Controller("hr/global/compliance")
@UseGuards(JwtAuthGuard)
export class ComplianceController {
  constructor(private readonly service: ComplianceRequirementsService) {}

  @Get("requirements")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compliance:manage")
  listRequirements(
    @Query(new ZodValidationPipe(listComplianceRequirementSchema)) query: ListComplianceRequirementInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listRequirements(u.orgId, query);
  }

  @Get("requirements/:requirementId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compliance:manage")
  getRequirement(
    @Param("requirementId", ParseIntPipe) requirementId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getRequirement(u.orgId, requirementId);
  }

  @Post("requirements")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compliance:manage")
  @HttpCode(201)
  createRequirement(
    @Body(new ZodValidationPipe(createComplianceRequirementSchema)) body: CreateComplianceRequirementInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createRequirement(u.orgId, u.userId, body);
  }

  @Patch("requirements/:requirementId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compliance:manage")
  updateRequirement(
    @Param("requirementId", ParseIntPipe) requirementId: number,
    @Body(new ZodValidationPipe(updateComplianceRequirementSchema)) body: UpdateComplianceRequirementInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateRequirement(u.orgId, requirementId, u.userId, body);
  }

  @Delete("requirements/:requirementId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compliance:manage")
  deleteRequirement(
    @Param("requirementId", ParseIntPipe) requirementId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.deleteRequirement(u.orgId, requirementId, u.userId);
  }

  @Get("events")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compliance:manage")
  listEvents(
    @Query(new ZodValidationPipe(listComplianceEventsSchema)) query: ListComplianceEventsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listEvents(u.orgId, query);
  }

  @Post("events/:eventId/done")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compliance:manage")
  @HttpCode(200)
  markEventDone(
    @Param("eventId", ParseIntPipe) eventId: number,
    @Body(new ZodValidationPipe(markEventDoneSchema)) body: MarkEventDoneInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.markEventDone(u.orgId, eventId, u.userId, body);
  }

  @Post("generate-events")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compliance:manage")
  @HttpCode(200)
  generateEvents(
    @Query("requirementId") requirementId: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const reqId = requirementId ? Number(requirementId) : undefined;
    return this.service.generateEvents(u.orgId, reqId);
  }

  @Post("seed-country-pack")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compliance:manage")
  @HttpCode(200)
  seedCountryPack(
    @Body(new ZodValidationPipe(seedCountryPackSchema)) body: SeedCountryPackInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.seedCountryPack(u.orgId, u.userId, body);
  }
}
