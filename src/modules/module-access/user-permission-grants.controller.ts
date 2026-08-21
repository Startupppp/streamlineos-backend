import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Put,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { UserPermissionGrantsService } from "./user-permission-grants.service";
import {
  setUserPermissionGrantsSchema,
  type SetUserPermissionGrantsInput,
} from "./dto/user-permission-grants.schemas";

@Controller("module-access/:moduleKey/members/:membershipId/grants")
@UseGuards(JwtAuthGuard)
export class UserPermissionGrantsController {
  constructor(private readonly grants: UserPermissionGrantsService) {}

  @Get()
  async list(
    @Param("moduleKey") moduleKey: string,
    @Param("membershipId", ParseIntPipe) membershipId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.grants.listGrants(u, moduleKey, membershipId);
  }

  @Put()
  async set(
    @Param("moduleKey") moduleKey: string,
    @Param("membershipId", ParseIntPipe) membershipId: number,
    @Body(new ZodValidationPipe(setUserPermissionGrantsSchema))
    body: SetUserPermissionGrantsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.grants.setGrants(u, moduleKey, membershipId, body);
  }

  @Delete(":permissionKey")
  async remove(
    @Param("moduleKey") moduleKey: string,
    @Param("membershipId", ParseIntPipe) membershipId: number,
    @Param("permissionKey") permissionKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.grants.removeGrant(u, moduleKey, membershipId, permissionKey);
  }
}
