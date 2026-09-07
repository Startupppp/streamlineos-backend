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
import { PartyDivergenceService } from "./party-divergence.service";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import {
  listPartiesQuerySchema,
  createPartySchema,
  updatePartySchema,
  createContactSchema,
  updateContactSchema,
  mirrorDivergenceQuerySchema,
  type MirrorDivergenceQuery,
  type ListPartiesQuery,
  type CreatePartyInput,
  type UpdatePartyInput,
  type CreateContactInput,
  type UpdateContactInput,
} from "./dto/party.schemas";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema, NoContentResponse } from "../../common/openapi/zod-operation-contracts";
import {
  mirrorDivergenceSchema,
  partyListSchema,
  partyDetailSchema,
  partyContactListSchema,
  partyContactDetailSchema,
} from "./dto/party-response.schemas";

const partyIdParams = z.object({ partyId: z.string().min(1) }).strict();
const partyContactIdParams = z.object({ partyContactId: z.string().min(1) }).strict();

@Controller("party")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class PartyController {
  constructor(
    private readonly svc: PartyService,
    private readonly divergence: PartyDivergenceService,
  ) {}

  /**
   * What the legacy mirror looks like right now.
   *
   * A GET because it changes nothing: it reports every `leads`, `clients` or
   * `contacts` row that disagrees with the Party it mirrors, and repairs none of
   * them. Silently rewriting a side would destroy the evidence of how the two
   * came apart, which is the only thing worth having once they have.
   */
  @Get("mirror/divergence")
  @RequirePermission("party:divergence:view")
  @ResponseSchema(mirrorDivergenceSchema)
  @Validate({ query: mirrorDivergenceQuerySchema })
  mirrorDivergence(
    @Query() query: MirrorDivergenceQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.divergence.report(u.orgId, {
      kinds: query.kind ? [query.kind] : undefined,
      limit: query.limit,
      after: query.kind ? { [query.kind]: query.after } : undefined,
    });
  }

  @Get("parties")
  @RequirePermission("party:parties:view")
  @ResponseSchema(partyListSchema)
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
  @ResponseSchema(partyDetailSchema)
  @Validate({ body: createPartySchema })
  createParty(
    @Body() body: CreatePartyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createParty(u.orgId, u.userId, body);
  }

  @Get("parties/:partyId")
  @RequirePermission("party:parties:view")
  @ResponseSchema(partyDetailSchema)
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
  @ResponseSchema(partyDetailSchema)
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
  @NoContentResponse()
  @Validate({ params: partyIdParams })
  deleteParty(
    @Param("partyId") partyId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.softDeleteParty(u.orgId, u.userId, partyId);
  }

  @Get("parties/:partyId/contacts")
  @RequirePermission("party:contacts:view")
  @ResponseSchema(partyContactListSchema)
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
  @ResponseSchema(partyContactDetailSchema)
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
  @ResponseSchema(partyContactDetailSchema)
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
  @NoContentResponse()
  @Validate({ params: partyContactIdParams })
  deleteContact(
    @Param("partyContactId") partyContactId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.softDeleteContact(u.orgId, u.userId, partyContactId);
  }
}
