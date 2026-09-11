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
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { WorkAuthorizationsService } from "./work-authorizations.service";
import {
  createWorkAuthSchema,
  updateWorkAuthSchema,
  listWorkAuthSchema,
  daysQuerySchema,
  type CreateWorkAuthInput,
  type UpdateWorkAuthInput,
  type ListWorkAuthInput,
} from "./dto/hr-global.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema, NoContentResponse } from "../../../common/openapi/zod-operation-contracts"
import { listWorkAuthsResponseSchema, listExpiringWorkAuthsResponseSchema, getWorkAuthResponseSchema, createWorkAuthResponseSchema, updateWorkAuthResponseSchema, removeWorkAuthResponseSchema } from "./dto/global-response.schemas"

const authIdParams = z.object({ authId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/global/work-authorizations")
@UseGuards(JwtAuthGuard)
export class WorkAuthorizationsController {
  constructor(private readonly service: WorkAuthorizationsService) {}

  @ResponseSchema(listWorkAuthsResponseSchema)
  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:view")
  @Validate({ query: listWorkAuthSchema })
  list(
    @Query() query: ListWorkAuthInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.list(u.orgId, query);
  }

  @ResponseSchema(listExpiringWorkAuthsResponseSchema)
  @Get("expiring")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compliance:manage")
  @Validate({ query: daysQuerySchema })
  listExpiring(
    @Query() { days }: z.infer<typeof daysQuerySchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.list(u.orgId, { limit: 100, days });
  }

  @ResponseSchema(getWorkAuthResponseSchema)
  @Get(":authId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:view")
  @Validate({ params: authIdParams })
  getOne(
    @Param("authId", ParseIntPipe) authId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getOne(u.orgId, authId);
  }

  @ResponseSchema(createWorkAuthResponseSchema)
  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compliance:manage")
  @HttpCode(201)
  @Validate({ body: createWorkAuthSchema })
  create(
    @Body() body: CreateWorkAuthInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.create(u.orgId, u.userId, body);
  }

  @ResponseSchema(updateWorkAuthResponseSchema)
  @Patch(":authId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compliance:manage")
  @Validate({ params: authIdParams, body: updateWorkAuthSchema })
  update(
    @Param("authId", ParseIntPipe) authId: number,
    @Body() body: UpdateWorkAuthInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.update(u.orgId, authId, u.userId, body);
  }

  @ResponseSchema(removeWorkAuthResponseSchema)
  @Delete(":authId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compliance:manage")
  @Validate({ params: authIdParams })
  remove(
    @Param("authId", ParseIntPipe) authId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.remove(u.orgId, authId, u.userId);
  }
}
