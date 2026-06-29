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
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrHelpdeskService } from "./hr-helpdesk.service";
import {
  createSchema,
  listSchema,
  type CreateInput,
  type ListInput,
} from "./dto/hr-helpdesk.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

function isHrAdmin(u: CurrentUserContext): boolean {
  return u.isOrgOwner || u.isPlatformAdmin || ["HR", "ADMIN", "CEO", "BRANCH_HR", "BRANCH_MANAGER"].includes(u.role);
}

@RequireModule("hr")
@Controller("hr/helpdesk")
@UseGuards(JwtAuthGuard)
export class HrHelpdeskController {
  constructor(private readonly helpdesk: HrHelpdeskService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(listSchema)) filters: ListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (filters.userId && filters.userId !== u.userId && !isHrAdmin(u)) {
      throw new ForbiddenException("Not authorized to view other users' tickets.");
    }
    return this.helpdesk.list(u.orgId, u.userId, isHrAdmin(u), filters);
  }

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createSchema)) body: CreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.helpdesk.create(u.orgId, u.userId, body);
  }
}
