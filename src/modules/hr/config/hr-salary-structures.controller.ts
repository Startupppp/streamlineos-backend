import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { AccessService } from "../../access/access.service";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Validate } from "../../../common/validation/validate.decorator";
import { HrSalaryStructuresService } from "./hr-salary-structures.service";
import {
  createSalaryStructureSchema,
  salaryStructureListQuerySchema,
  type CreateSalaryStructureInput,
  type SalaryStructureListQuery,
} from "./dto/salary-structures.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";

@RequireModule("hr")
@Controller("hr/salary-structures")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrSalaryStructuresController {
  constructor(
    private readonly salaryStructures: HrSalaryStructuresService,
    private readonly access: AccessService,
  ) {}

  @Get()
  @RequirePermission("hr:salary:view")
  @Validate({ query: salaryStructureListQuerySchema })
  async list(
    @Query() query: SalaryStructureListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    const scope = u.isOrgOwner ? "all" : (perms.get("hr:salary:view") ?? "none");
    const isAdmin = scope === "all";
    const effectiveUserId = isAdmin ? query.userId : u.userId;
    return this.salaryStructures.list(u.orgId, effectiveUserId, u.userId, isAdmin);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:salary:manage")
  @HttpCode(201)
  @Validate({ body: createSalaryStructureSchema })
  create(
    @Body() body: CreateSalaryStructureInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.salaryStructures.create(u.orgId, u.userId, body);
  }
}
