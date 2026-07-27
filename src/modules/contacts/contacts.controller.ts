import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
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
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ContactsService } from "./contacts.service";
import { buildVcard, vcardFilename } from "./vcard";
import {
  bulkImportContactsSchema,
  createSchema,
  listSchema,
  searchSchema,
  updateSchema,
  type BulkImportContactsInput,
  type CreateInput,
  type ListInput,
  type SearchInput,
  type UpdateInput,
} from "./dto/contact.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { Deprecated } from "../../common/deprecation/deprecated.decorator";

@RequireModule("crm")
@Controller("contacts")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get()
  @RequirePermission("crm:contacts:view")
  list(
    @Query(new ZodValidationPipe(listSchema)) filters: ListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.contacts.list(u.orgId, filters);
  }

  @Deprecated({ sunset: "2026-10-25", link: "/party/parties/:partyId/contacts" })
  @Post()
  @HttpCode(201)
  @RequirePermission("crm:contacts:manage")
  create(
    @Body(new ZodValidationPipe(createSchema)) body: CreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.contacts.create(u.orgId, body);
  }

  @Post("bulk-import")
  @HttpCode(201)
  @RequirePermission("crm:contacts:manage")
  bulkImport(
    @Body(new ZodValidationPipe(bulkImportContactsSchema)) body: BulkImportContactsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.contacts.bulkImport(u.orgId, body);
  }

  @Get("export")
  @RequirePermission("crm:contacts:view")
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="contacts-export.csv"')
  exportCsv(@CurrentUser() u: CurrentUserContext) {
    return this.contacts.exportCsv(u.orgId);
  }

  @Get("search")
  @RequirePermission("crm:contacts:view")
  search(
    @Query(new ZodValidationPipe(searchSchema)) query: SearchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.contacts.search(u.orgId, query.q);
  }

  @Get(":contactId")
  @RequirePermission("crm:contacts:view")
  async get(
    @Param("contactId", ParseIntPipe) contactId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const contact = await this.contacts.getContact(u.orgId, contactId);
    if (!contact) throw new NotFoundException("Contact not found");
    return contact;
  }

  @Deprecated({ sunset: "2026-10-25", link: "/party/contacts/:partyContactId" })
  @Patch(":contactId")
  @RequirePermission("crm:contacts:manage")
  async update(
    @Param("contactId", ParseIntPipe) contactId: number,
    @Body(new ZodValidationPipe(updateSchema)) body: UpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.contacts.update(u.orgId, contactId, body);
    if (!updated) throw new NotFoundException("Contact not found");
    return updated;
  }

  @Deprecated({ sunset: "2026-10-25", link: "/party/contacts/:partyContactId" })
  @Delete(":contactId")
  @HttpCode(204)
  @RequirePermission("crm:contacts:manage")
  async remove(
    @Param("contactId", ParseIntPipe) contactId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.contacts.remove(u.orgId, contactId);
  }

  @Get(":contactId/vcard")
  @RequirePermission("crm:contacts:view")
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
