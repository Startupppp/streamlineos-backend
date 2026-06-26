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
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { defineAbilityFor } from "../../common/rbac/abilities.factory";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrSalaryStructuresService } from "./hr-salary-structures.service";
import {
  createSalaryStructureSchema,
  salaryStructureListQuerySchema,
  type CreateSalaryStructureInput,
  type SalaryStructureListQuery,
} from "./dto/salary-structures.schemas";

@Controller("hr/salary-structures")
@UseGuards(JwtAuthGuard)
export class HrSalaryStructuresController {
  constructor(private readonly salaryStructures: HrSalaryStructuresService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(salaryStructureListQuerySchema)) query: SalaryStructureListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const isAdmin = defineAbilityFor(u).can("manage", "hr:salary");
    if (query.userId && query.userId !== u.userId && !isAdmin) {
      throw new ForbiddenException("Not authorized.");
    }
    return this.salaryStructures.list(u.orgId, query.userId, u.userId, isAdmin);
  }

  @Post()
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "hr:salary")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createSalaryStructureSchema)) body: CreateSalaryStructureInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.salaryStructures.create(u.orgId, u.userId, body);
  }
}
