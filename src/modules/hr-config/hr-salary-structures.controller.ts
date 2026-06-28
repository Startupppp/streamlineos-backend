import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { AccessService } from "../access/access.service";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrSalaryStructuresService } from "./hr-salary-structures.service";
import {
  createSalaryStructureSchema,
  salaryStructureListQuerySchema,
  type CreateSalaryStructureInput,
  type SalaryStructureListQuery,
} from "./dto/salary-structures.schemas";

@Controller("hr/salary-structures")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrSalaryStructuresController {
  constructor(
    private readonly salaryStructures: HrSalaryStructuresService,
    private readonly access: AccessService,
  ) {}

  @Get()
  @RequirePermission("hr:salary:view")
  async list(
    @Query(new ZodValidationPipe(salaryStructureListQuerySchema)) query: SalaryStructureListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    const isAdmin = u.isOrgOwner || u.isPlatformAdmin || perms.has("hr:salary:manage");
    if (query.userId && query.userId !== u.userId && !isAdmin) {
      throw new ForbiddenException("Not authorized.");
    }
    return this.salaryStructures.list(u.orgId, query.userId, u.userId, isAdmin);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:salary:manage")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createSalaryStructureSchema)) body: CreateSalaryStructureInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.salaryStructures.create(u.orgId, u.userId, body);
  }
}
