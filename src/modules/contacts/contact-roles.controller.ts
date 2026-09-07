import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ContactRolesService } from "./contact-roles.service";
import {
  contactRoleCreateSchema,
  contactRoleListSchema,
  mergeContactsSchema,
  duplicatesQuerySchema,
  type ContactRoleCreateInput,
  type ContactRoleListInput,
  type MergeContactsInput,
  type DuplicatesQueryInput,
} from "./dto/contact-roles.schemas";
import { Validate } from "../../common/validation/validate.decorator";
import { NoContentResponse, ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  contactRoleListResponseSchema,
  contactRoleRowSchema,
  duplicateContactsResponseSchema,
  mergeContactsResponseSchema,
} from "./dto/contacts-response.schemas";
import { z } from "zod";

const contactIdParams = z.object({ contactId: z.coerce.number().int().positive() }).strict();
const contactIdroleIdParams = z.object({ contactId: z.coerce.number().int().positive(), roleId: z.string().min(1) }).strict();

@RequireModule("crm")
@Controller("contacts")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ContactRolesController {
  constructor(private readonly svc: ContactRolesService) {}

  @Get("duplicates")
  @ResponseSchema(duplicateContactsResponseSchema)
  @RequirePermission("crm:contacts:view")
  @Validate({ query: duplicatesQuerySchema })
  getDuplicates(
    @Query() query: DuplicatesQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getDuplicateContacts(u.orgId, query);
  }

  @Post("merge")
  @HttpCode(200)
  @ResponseSchema(mergeContactsResponseSchema)
  @RequirePermission("crm:contacts:merge")
  @Validate({ body: mergeContactsSchema })
  mergeContacts(
    @Body() body: MergeContactsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.mergeContacts(u.orgId, body, u.userId);
  }

  @Get(":contactId/roles")
  @ResponseSchema(contactRoleListResponseSchema)
  @RequirePermission("crm:contacts:view")
  @Validate({ params: contactIdParams, query: contactRoleListSchema })
  listRoles(
    @Param("contactId", ParseIntPipe) contactId: number,
    @Query() query: ContactRoleListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listRoles(u.orgId, contactId, query);
  }

  @Post(":contactId/roles")
  @HttpCode(201)
  @ResponseSchema(contactRoleRowSchema)
  @RequirePermission("crm:contacts:manage")
  @Validate({ params: contactIdParams, body: contactRoleCreateSchema })
  addRole(
    @Param("contactId", ParseIntPipe) contactId: number,
    @Body() body: ContactRoleCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.addRole(u.orgId, contactId, body, u.userId);
  }

  @Delete(":contactId/roles/:roleId")
  @HttpCode(204)
  @NoContentResponse()
  @RequirePermission("crm:contacts:manage")
  @Validate({ params: contactIdroleIdParams })
  async removeRole(
    @Param("contactId", ParseIntPipe) contactId: number,
    @Param("roleId") roleId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.svc.removeRole(u.orgId, contactId, roleId, u.userId);
  }
}
