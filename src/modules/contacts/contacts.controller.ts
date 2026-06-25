import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ContactsService } from "./contacts.service";
import { buildVcard, vcardFilename } from "./vcard";
import {
  createSchema,
  listSchema,
  searchSchema,
  updateSchema,
  type CreateInput,
  type ListInput,
  type SearchInput,
  type UpdateInput,
} from "./dto/contact.schemas";

@Controller("contacts")
@UseGuards(JwtAuthGuard)
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(listSchema)) filters: ListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.contacts.list(u.orgId, filters);
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(createSchema)) body: CreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.contacts.create(u.orgId, body);
  }

  @Get("search")
  search(
    @Query(new ZodValidationPipe(searchSchema)) query: SearchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.contacts.search(u.orgId, query.q);
  }

  @Get(":contactId")
  async get(
    @Param("contactId", ParseIntPipe) contactId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const contact = await this.contacts.getContact(u.orgId, contactId);
    if (!contact) throw new NotFoundException("Contact not found");
    return contact;
  }

  @Patch(":contactId")
  async update(
    @Param("contactId", ParseIntPipe) contactId: number,
    @Body(new ZodValidationPipe(updateSchema)) body: UpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.contacts.update(u.orgId, contactId, body);
    if (!updated) throw new NotFoundException("Contact not found");
    return updated;
  }

  @Delete(":contactId")
  remove(
    @Param("contactId", ParseIntPipe) contactId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.contacts.remove(u.orgId, contactId);
  }

  @Get(":contactId/vcard")
  async vcard(
    @Param("contactId", ParseIntPipe) contactId: number,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ) {
    const contact = await this.contacts.getContact(u.orgId, contactId);
    if (!contact) throw new NotFoundException("Contact not found");

    const body = buildVcard(contact);
    res.setHeader("Content-Type", "text/vcard; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${vcardFilename(contact.name)}.vcf"`);
    res.send(body);
  }
}
