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
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { UpdatesService } from "./updates.service";
import {
  createUpdateSchema,
  editUpdateSchema,
  listUpdatesQuerySchema,
  type CreateUpdateInput,
  type EditUpdateInput,
  type ListUpdatesQuery,
} from "./dto/updates.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { updateRowSchema, updateListPageSchema } from "./dto/updates-response.schemas";

export const updateIdParams = z
  .object({ projectId: z.coerce.number().int().positive(), updateId: z.coerce.number().int().positive() })
  .strict();

@RequireModule("build")
@Controller("build/:projectId/updates")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class UpdatesController {
  constructor(private readonly svc: UpdatesService) {}

  @Get()
  @RequirePermission("build:updates:view")
  @ResponseSchema(updateListPageSchema)
  @Validate({ query: listUpdatesQuerySchema })
  listUpdates(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query() query: ListUpdatesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listUpdates(u, projectId, query);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:updates:manage")
  @Idempotent("build.update.create", { required: false })
  @ResponseSchema(updateRowSchema)
  @Validate({ body: createUpdateSchema })
  createUpdate(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: CreateUpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createUpdate(u, projectId, body);
  }

  @Patch(":updateId")
  @RequirePermission("build:updates:manage")
  @ResponseSchema(updateRowSchema)
  @Validate({ params: updateIdParams, body: editUpdateSchema })
  editUpdate(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("updateId", ParseIntPipe) updateId: number,
    @Body() body: EditUpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.editUpdate(u, projectId, updateId, body);
  }

  @Delete(":updateId")
  @HttpCode(204)
  @RequirePermission("build:updates:manage")
  @NoContentResponse()
  @Validate({ params: updateIdParams })
  softDeleteUpdate(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("updateId", ParseIntPipe) updateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.softDeleteUpdate(u, projectId, updateId);
  }
}
