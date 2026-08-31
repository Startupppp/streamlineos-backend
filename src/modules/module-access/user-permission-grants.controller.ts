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
import { AuthorizedInService } from "../../common/auth/authorized-in-service.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { UserPermissionGrantsService } from "./user-permission-grants.service";
import {
  setUserPermissionGrantsSchema,
  type SetUserPermissionGrantsInput,
} from "./dto/user-permission-grants.schemas";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";

const grantBaseParams = z.object({ moduleKey: z.string().min(1), membershipId: z.coerce.number().int().positive() }).strict();
const grantAndPermissionKeyParams = z.object({ moduleKey: z.string().min(1), membershipId: z.coerce.number().int().positive(), permissionKey: z.string().min(1) }).strict();

@Controller("module-access/:moduleKey/members/:membershipId/grants")
@UseGuards(JwtAuthGuard)
@AuthorizedInService("assertModuleAccessPolicy")
export class UserPermissionGrantsController {
  constructor(private readonly grants: UserPermissionGrantsService) {}

  @Get()
  @Validate({ params: grantBaseParams })
  async list(
    @Param("moduleKey") moduleKey: string,
    @Param("membershipId", ParseIntPipe) membershipId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.grants.listGrants(u, moduleKey, membershipId);
  }

  @Put()
  @Validate({ params: grantBaseParams, body: setUserPermissionGrantsSchema })
  async set(
    @Param("moduleKey") moduleKey: string,
    @Param("membershipId", ParseIntPipe) membershipId: number,
    @Body() body: SetUserPermissionGrantsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.grants.setGrants(u, moduleKey, membershipId, body);
  }

  @Delete(":permissionKey")
  @Validate({ params: grantAndPermissionKeyParams })
  async remove(
    @Param("moduleKey") moduleKey: string,
    @Param("membershipId", ParseIntPipe) membershipId: number,
    @Param("permissionKey") permissionKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.grants.removeGrant(u, moduleKey, membershipId, permissionKey);
  }
}
