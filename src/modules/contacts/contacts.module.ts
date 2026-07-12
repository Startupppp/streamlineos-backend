import { Module } from "@nestjs/common";
import { ContactsController } from "./contacts.controller";
import { ContactsService } from "./contacts.service";
import { ContactRolesController } from "./contact-roles.controller";
import { ContactRolesService } from "./contact-roles.service";

@Module({
  controllers: [ContactsController, ContactRolesController],
  providers: [ContactsService, ContactRolesService],
})
export class ContactsModule {}
