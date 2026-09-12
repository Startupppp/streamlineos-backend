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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { BooksService } from "../kernel/books.service";
import { PartiesService } from "./parties.service";
import {
  createPartySchema,
  createTaxRegistrationSchema,
  listPartiesSchema,
  resolvePartySchema,
  updatePartySchema,
  type CreatePartyInput,
  type CreateTaxRegistrationInput,
  type ListPartiesQuery,
  type ResolvePartyInput,
  type UpdatePartyInput,
} from "./dto/parties.schemas";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  addPartyRegistrationResponseSchema,
  createPartyResponseSchema,
  getPartyResponseSchema,
  listPartiesResponseSchema,
  listPartyRegistrationsResponseSchema,
  removePartyRegistrationResponseSchema,
  removePartyResponseSchema,
  resolvePartyResponseSchema,
  updatePartyResponseSchema,
} from "./dto/parties-response.schemas";

/**
 * The party master is shared, so it is gated by the generic accounting keys
 * rather than by `receivables` or `payables` — a vendor manager must be able to
 * maintain a vendor without holding AR permissions, and vice versa. There is no
 * `accounting:parties:*` key in the catalog; adding one is a catalog change,
 * which is not this module's to make.
 */
@RequireModule("accounting")
@Controller("accounting/parties")
@UseGuards(JwtAuthGuard)
export class PartiesController {
  constructor(
    private readonly parties: PartiesService,
    private readonly books: BooksService,
  ) {}

  @Get()
  @ResponseSchema(listPartiesResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:read")
  list(
    @Query(new ZodValidationPipe(listPartiesSchema)) query: ListPartiesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.parties.list(u.orgId, query);
  }

  @Post()
  @ResponseSchema(createPartyResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:create")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createPartySchema)) body: CreatePartyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.parties.create(u.orgId, u.userId, body);
  }

  /**
   * Upsert by external reference. This is the endpoint CRM calls, and calling it
   * twice for the same company returns the same party — no duplicate customer.
   */
  @Post("resolve")
  @ResponseSchema(resolvePartyResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:create")
  @HttpCode(200)
  async resolve(
    @Body(new ZodValidationPipe(resolvePartySchema)) body: ResolvePartyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const book = await this.books.requireDefault(u.orgId);
    return this.parties.resolveOrCreateByExternalRef(
      u.orgId,
      book.id,
      body.externalRef,
      body.fields,
      u.userId,
    );
  }

  @Get(":partyId")
  @ResponseSchema(getPartyResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:read")
  get(@Param("partyId") partyId: string, @CurrentUser() u: CurrentUserContext) {
    return this.parties.get(u.orgId, partyId);
  }

  @Patch(":partyId")
  @ResponseSchema(updatePartyResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:update")
  update(
    @Param("partyId") partyId: string,
    @Body(new ZodValidationPipe(updatePartySchema)) body: UpdatePartyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.parties.update(u.orgId, partyId, body);
  }

  @Delete(":partyId")
  @ResponseSchema(removePartyResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:update")
  remove(@Param("partyId") partyId: string, @CurrentUser() u: CurrentUserContext) {
    return this.parties.remove(u.orgId, partyId);
  }

  @Get(":partyId/tax-registrations")
  @ResponseSchema(listPartyRegistrationsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:read")
  listRegistrations(@Param("partyId") partyId: string, @CurrentUser() u: CurrentUserContext) {
    return this.parties.listRegistrations(u.orgId, partyId);
  }

  @Post(":partyId/tax-registrations")
  @ResponseSchema(addPartyRegistrationResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:taxes:manage")
  @HttpCode(201)
  addRegistration(
    @Param("partyId") partyId: string,
    @Body(new ZodValidationPipe(createTaxRegistrationSchema)) body: CreateTaxRegistrationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.parties.addRegistration(u.orgId, partyId, body);
  }

  @Delete(":partyId/tax-registrations/:registrationId")
  @ResponseSchema(removePartyRegistrationResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:taxes:manage")
  removeRegistration(
    @Param("partyId") partyId: string,
    @Param("registrationId") registrationId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.parties.removeRegistration(u.orgId, partyId, registrationId);
  }
}
