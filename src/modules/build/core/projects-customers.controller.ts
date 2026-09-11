import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Validate } from "../../../common/validation/validate.decorator";
import { ProjectsCustomersService } from "./projects-customers.service";
import {
  listProjectCustomersSchema,
  type ListProjectCustomersInput,
} from "./dto/projects-customers.schemas";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { customerPageSchema } from "./dto/build-reports-response.schemas";

@RequireModule("build")
@Controller("build/customers")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsCustomersController {
  constructor(private readonly svc: ProjectsCustomersService) {}

  @Get()
  @RequirePermission("build:customers:view")
  @ResponseSchema(customerPageSchema)
  @Validate({ query: listProjectCustomersSchema })
  list(
    @Query() query: ListProjectCustomersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.list(u.orgId, query);
  }
}
