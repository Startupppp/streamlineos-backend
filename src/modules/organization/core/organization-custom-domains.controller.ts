import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction, NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  customDomainListResponseSchema,
  addCustomDomainResponseSchema,
  verifyCustomDomainResponseSchema,
} from "./dto/organization-core-response.schemas";
import { OrgCustomDomainsService } from "./org-custom-domains.service";
import { addCustomDomainSchema, type AddCustomDomainInput } from "./dto/organization.schemas";
import { z } from "zod";

const domainIdParams = z.object({ domainId: z.string().min(1) }).strict();

@Controller("organization")
@UseGuards(JwtAuthGuard)
export class OrganizationCustomDomainsController {
  constructor(private readonly customDomains: OrgCustomDomainsService) {}

  @UseGuards(PermissionGuard)
  @RequirePermission("settings:view")
  @Get("custom-domains")
  @ResponseSchema(customDomainListResponseSchema)
  listCustomDomains(@CurrentUser() u: CurrentUserContext) {
    return this.customDomains.listCustomDomains(u.orgId);
  }

  @Post("custom-domains")
  @ResponseSchema(addCustomDomainResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  @Validate({ body: addCustomDomainSchema })
  addCustomDomain(
    @Body() body: AddCustomDomainInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.customDomains.addCustomDomain(u.orgId, u.userId, body);
  }

  @Post("custom-domains/:domainId/verify")
  @BodylessAction()
  @ResponseSchema(verifyCustomDomainResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  @Validate({ params: domainIdParams })
  verifyCustomDomain(
    @Param("domainId") domainId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.customDomains.verifyCustomDomain(u.orgId, u.userId, domainId);
  }

  @Delete("custom-domains/:domainId")
  @NoContentResponse()
  @HttpCode(204)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  @Validate({ params: domainIdParams })
  async removeCustomDomain(
    @Param("domainId") domainId: string,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<void> {
    await this.customDomains.removeCustomDomain(u.orgId, u.userId, domainId);
  }
}
