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
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { LaborService } from "./labor.service";
import {
  createUnionMembershipSchema, updateUnionMembershipSchema, listUnionMembershipsSchema,
  createCollectiveAgreementSchema, updateCollectiveAgreementSchema, listAgreementsSchema, expiringAgreementsSchema,
  createLaborCaseSchema, updateLaborCaseSchema, listLaborCasesSchema,
  type CreateUnionMembershipInput, type UpdateUnionMembershipInput, type ListUnionMembershipsInput,
  type CreateCollectiveAgreementInput, type UpdateCollectiveAgreementInput, type ListAgreementsInput, type ExpiringAgreementsInput,
  type CreateLaborCaseInput, type UpdateLaborCaseInput, type ListLaborCasesInput,
} from "./labor.dto";
import { Validate } from "../../../../common/validation/validate.decorator";
import { z } from "zod";

const membershipIdParams = z.object({ membershipId: z.coerce.number().int().positive() }).strict();
const agreementIdParams = z.object({ agreementId: z.coerce.number().int().positive() }).strict();
const caseIdParams = z.object({ caseId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/governance/labor")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class LaborController {
  constructor(private readonly service: LaborService) {}

  @Get("memberships")
  @RequirePermission("hr:labor:view")
  @Validate({ query: listUnionMembershipsSchema })
  async listMemberships(
    @CurrentUser() user: CurrentUserContext,
    @Query() query: ListUnionMembershipsInput,
  ) {
    return this.service.listMemberships(user.orgId, query);
  }

  @Post("memberships")
  @RequirePermission("hr:labor:manage")
  @Validate({ body: createUnionMembershipSchema })
  async createMembership(
    @CurrentUser() user: CurrentUserContext,
    @Body() body: CreateUnionMembershipInput,
    @Req() req: Request,
  ) {
    return this.service.createMembership(user.orgId, user.userId, body, req.ip);
  }

  @Patch("memberships/:membershipId")
  @RequirePermission("hr:labor:manage")
  @Validate({ params: membershipIdParams, body: updateUnionMembershipSchema })
  async updateMembership(
    @CurrentUser() user: CurrentUserContext,
    @Param("membershipId", ParseIntPipe) membershipId: number,
    @Body() body: UpdateUnionMembershipInput,
    @Req() req: Request,
  ) {
    return this.service.updateMembership(user.orgId, membershipId, user.userId, body, req.ip);
  }

  @Delete("memberships/:membershipId")
  @RequirePermission("hr:labor:manage")
  @HttpCode(204)
  @Validate({ params: membershipIdParams })
  async deleteMembership(
    @CurrentUser() user: CurrentUserContext,
    @Param("membershipId", ParseIntPipe) membershipId: number,
    @Req() req: Request,
  ) {
    await this.service.deleteMembership(user.orgId, membershipId, user.userId, req.ip);
  }

  @Get("agreements/expiring")
  @RequirePermission("hr:labor:view")
  @Validate({ query: expiringAgreementsSchema })
  async listExpiringAgreements(
    @CurrentUser() user: CurrentUserContext,
    @Query() query: ExpiringAgreementsInput,
  ) {
    return this.service.listExpiringAgreements(user.orgId, query);
  }

  @Get("agreements")
  @RequirePermission("hr:labor:view")
  @Validate({ query: listAgreementsSchema })
  async listAgreements(
    @CurrentUser() user: CurrentUserContext,
    @Query() query: ListAgreementsInput,
  ) {
    return this.service.listAgreements(user.orgId, query);
  }

  @Post("agreements")
  @RequirePermission("hr:labor:manage")
  @Validate({ body: createCollectiveAgreementSchema })
  async createAgreement(
    @CurrentUser() user: CurrentUserContext,
    @Body() body: CreateCollectiveAgreementInput,
    @Req() req: Request,
  ) {
    return this.service.createAgreement(user.orgId, user.userId, body, req.ip);
  }

  @Patch("agreements/:agreementId")
  @RequirePermission("hr:labor:manage")
  @Validate({ params: agreementIdParams, body: updateCollectiveAgreementSchema })
  async updateAgreement(
    @CurrentUser() user: CurrentUserContext,
    @Param("agreementId", ParseIntPipe) agreementId: number,
    @Body() body: UpdateCollectiveAgreementInput,
    @Req() req: Request,
  ) {
    return this.service.updateAgreement(user.orgId, agreementId, user.userId, body, req.ip);
  }

  @Delete("agreements/:agreementId")
  @RequirePermission("hr:labor:manage")
  @HttpCode(204)
  @Validate({ params: agreementIdParams })
  async deleteAgreement(
    @CurrentUser() user: CurrentUserContext,
    @Param("agreementId", ParseIntPipe) agreementId: number,
    @Req() req: Request,
  ) {
    await this.service.deleteAgreement(user.orgId, agreementId, user.userId, req.ip);
  }

  @Get("cases")
  @RequirePermission("hr:labor:view")
  @Validate({ query: listLaborCasesSchema })
  async listLaborCases(
    @CurrentUser() user: CurrentUserContext,
    @Query() query: ListLaborCasesInput,
  ) {
    return this.service.listLaborCases(user.orgId, query);
  }

  @Post("cases")
  @RequirePermission("hr:labor:manage")
  @Validate({ body: createLaborCaseSchema })
  async createLaborCase(
    @CurrentUser() user: CurrentUserContext,
    @Body() body: CreateLaborCaseInput,
    @Req() req: Request,
  ) {
    return this.service.createLaborCase(user.orgId, user.userId, body, req.ip);
  }

  @Patch("cases/:caseId")
  @RequirePermission("hr:labor:manage")
  @Validate({ params: caseIdParams, body: updateLaborCaseSchema })
  async updateLaborCase(
    @CurrentUser() user: CurrentUserContext,
    @Param("caseId", ParseIntPipe) caseId: number,
    @Body() body: UpdateLaborCaseInput,
    @Req() req: Request,
  ) {
    return this.service.updateLaborCase(user.orgId, caseId, user.userId, body, req.ip);
  }

  @Delete("cases/:caseId")
  @RequirePermission("hr:labor:manage")
  @HttpCode(204)
  @Validate({ params: caseIdParams })
  async deleteLaborCase(
    @CurrentUser() user: CurrentUserContext,
    @Param("caseId", ParseIntPipe) caseId: number,
    @Req() req: Request,
  ) {
    await this.service.deleteLaborCase(user.orgId, caseId, user.userId, req.ip);
  }
}
