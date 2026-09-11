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
import { once } from "node:events";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AccessService } from "../access/access.service";
import { ContactsService } from "./contacts.service";
import { resolveContactsViewScope } from "./contacts-scope";
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
import { Validate } from "../../common/validation/validate.decorator";
import { NoTenantTransaction } from "../../common/tenant/no-tenant-transaction.decorator";
import { z } from "zod";
import { ResponseSchema, NoContentResponse } from "../../common/openapi/zod-operation-contracts";
import { ApiOkResponse } from "@nestjs/swagger";
import {
  contactListSchema,
  contactDetailSchema,
  bulkImportSchema,
  contactSearchSchema,
} from "./dto/contacts-response.schemas";

const contactIdParams = z.object({ contactId: z.coerce.number().int().positive() }).strict();

@RequireModule("crm")
@Controller("contacts")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ContactsController {
  constructor(
    private readonly contacts: ContactsService,
    private readonly access: AccessService,
  ) {}

  @Get()
  @RequirePermission("crm:contacts:view")
  @ResponseSchema(contactListSchema)
  @Validate({ query: listSchema })
  async list(
    @Query() filters: ListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const read = await resolveContactsViewScope(this.access, u);
    return this.contacts.list(read, filters);
  }

  @Deprecated({ sunset: "2026-10-25", link: "/party/parties/:partyId/contacts" })
  @Post()
  @HttpCode(201)
  @RequirePermission("crm:contacts:manage")
  @ResponseSchema(contactDetailSchema)
  @Validate({ body: createSchema })
  create(
    @Body() body: CreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.contacts.create(u.orgId, body);
  }

  @Post("bulk-import")
  @HttpCode(201)
  @RequirePermission("crm:contacts:manage")
  @ResponseSchema(bulkImportSchema)
  @Validate({ body: bulkImportContactsSchema })
  bulkImport(
    @Body() body: BulkImportContactsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.contacts.bulkImport(u.orgId, body);
  }

  @Get("export")
  @RequirePermission("crm:contacts:view")
  @NoTenantTransaction()
  @ApiOkResponse({ description: "CSV file stream", content: { "text/csv": { schema: { type: "string" } } } })
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="contacts-export.csv"')
  async exportCsv(
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    const read = await resolveContactsViewScope(this.access, u);
    for await (const chunk of this.contacts.exportCsvChunks(read)) {
      if (res.destroyed) return;
      if (!res.write(chunk)) await once(res, "drain");
    }
    res.end();
  }

  @Get("search")
  @RequirePermission("crm:contacts:view")
  @ResponseSchema(contactSearchSchema)
  @Validate({ query: searchSchema })
  async search(
    @Query() query: SearchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const read = await resolveContactsViewScope(this.access, u);
    return this.contacts.search(read, query.q);
  }

  @Get(":contactId")
  @RequirePermission("crm:contacts:view")
  @ResponseSchema(contactDetailSchema)
  @Validate({ params: contactIdParams })
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
  @ResponseSchema(contactDetailSchema)
  @Validate({ params: contactIdParams, body: updateSchema })
  async update(
    @Param("contactId", ParseIntPipe) contactId: number,
    @Body() body: UpdateInput,
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
  @NoContentResponse()
  @Validate({ params: contactIdParams })
  async remove(
    @Param("contactId", ParseIntPipe) contactId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.contacts.remove(u.orgId, contactId);
  }

  @Get(":contactId/vcard")
  @RequirePermission("crm:contacts:view")
  @ApiOkResponse({ description: "vCard file", content: { "text/vcard": { schema: { type: "string" } } } })
  @Validate({ params: contactIdParams })
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
