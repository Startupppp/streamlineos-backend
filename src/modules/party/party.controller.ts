import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { PartyService } from "./party.service";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import {
  listPartiesQuerySchema,
  createPartySchema,
  updatePartySchema,
  createContactSchema,
  updateContactSchema,
  type ListPartiesQuery,
  type CreatePartyInput,
  type UpdatePartyInput,
  type CreateContactInput,
  type UpdateContactInput,
} from "./dto/party.schemas";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";

const partyIdParams = z.object({ partyId: z.string().min(1) }).strict();
const partyContactIdParams = z.object({ partyContactId: z.string().min(1) }).strict();

@Controller("party")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class PartyController {
  constructor(private readonly svc: PartyService) {}

  @Get("parties")
  @RequirePermission("party:parties:view")
  @Validate({ query: listPartiesQuerySchema })
  listParties(
    @Query() query: ListPartiesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listParties(u.orgId, query);
  }

  @Post("parties")
  @Idempotent("party.create")
  @HttpCode(201)
  @RequirePermission("party:parties:create")
  @Validate({ body: createPartySchema })
  createParty(
    @Body() body: CreatePartyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createParty(u.orgId, u.userId, body);
  }

  @Get("parties/:partyId")
  @RequirePermission("party:parties:view")
  @Validate({ params: partyIdParams })
  getParty(
    @Param("partyId") partyId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getParty(u.orgId, partyId);
  }

  @Patch("parties/:partyId")
  @Idempotent("party.update")
  @RequirePermission("party:parties:update")
  @Validate({ params: partyIdParams, body: updatePartySchema })
  updateParty(
    @Param("partyId") partyId: string,
    @Body() body: UpdatePartyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateParty(u.orgId, u.userId, partyId, body);
  }

  @Delete("parties/:partyId")
  @Idempotent("party.delete")
  @HttpCode(204)
  @RequirePermission("party:parties:delete")
  @Validate({ params: partyIdParams })
  deleteParty(
    @Param("partyId") partyId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.softDeleteParty(u.orgId, u.userId, partyId);
  }

  @Get("parties/:partyId/contacts")
  @RequirePermission("party:contacts:view")
  @Validate({ params: partyIdParams })
  listContacts(
    @Param("partyId") partyId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listContacts(u.orgId, partyId);
  }

  @Post("parties/:partyId/contacts")
  @Idempotent("party.contact.create")
  @HttpCode(201)
  @RequirePermission("party:contacts:manage")
  @Validate({ params: partyIdParams, body: createContactSchema })
  createContact(
    @Param("partyId") partyId: string,
    @Body() body: CreateContactInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createContact(u.orgId, u.userId, { ...body, partyId });
  }

  @Patch("contacts/:partyContactId")
  @Idempotent("party.contact.update")
  @RequirePermission("party:contacts:manage")
  @Validate({ params: partyContactIdParams, body: updateContactSchema })
  updateContact(
    @Param("partyContactId") partyContactId: string,
    @Body() body: UpdateContactInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateContact(u.orgId, u.userId, partyContactId, body);
  }

  @Delete("contacts/:partyContactId")
  @Idempotent("party.contact.delete")
  @HttpCode(204)
  @RequirePermission("party:contacts:manage")
  @Validate({ params: partyContactIdParams })
  deleteContact(
    @Param("partyContactId") partyContactId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.softDeleteContact(u.orgId, u.userId, partyContactId);
  }
}
