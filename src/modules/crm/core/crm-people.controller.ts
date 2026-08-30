import { Controller, Get, NotFoundException, Param, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { CrmPeopleService } from "./crm-people.service";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const entityIdParams = z.object({ entityId: z.string().min(1) }).strict();

@RequireModule("crm")
@Controller("crm")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CrmPeopleController {
  constructor(private readonly people: CrmPeopleService) {}

  @Get("people-slugs")
  @RequirePermission("crm:contacts:view")
  slugs(@CurrentUser() u: CurrentUserContext) {
    return this.people.getAllPeopleSlugs(u.orgId);
  }

  @Get("people/:entityId")
  @RequirePermission("crm:contacts:view")
  @Validate({ params: entityIdParams })
  async person(@Param("entityId") entityId: string, @CurrentUser() u: CurrentUserContext) {
    const data = await this.people.getPersonBySlug(u.orgId, entityId);
    if (!data) throw new NotFoundException("Person not found");
    return data;
  }
}
