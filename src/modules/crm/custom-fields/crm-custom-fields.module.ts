import { Module } from "@nestjs/common";
import { CrmCustomFieldsController } from "./crm-custom-fields.controller";
import { CrmCustomFieldsService } from "./crm-custom-fields.service";

@Module({
  controllers: [CrmCustomFieldsController],
  providers: [CrmCustomFieldsService],
  exports: [CrmCustomFieldsService],
})
export class CrmCustomFieldsModule {}
