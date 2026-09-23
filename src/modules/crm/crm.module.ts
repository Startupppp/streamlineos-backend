import { Module } from "@nestjs/common";
import { CrmModule } from "./core/crm.module";
import { CrmAttentionModule } from "./crm-attention.module";
import { CrmAutomationStudioModule } from "./automation-studio/crm-automation-studio.module";
import { CrmCustomFieldsModule } from "./custom-fields/crm-custom-fields.module";
import { CrmInboxModule } from "./inbox/crm-inbox.module";
import { CrmMetadataModule } from "./metadata/crm-metadata.module";
import { CrmPricebooksModule } from "./pricebooks/crm-pricebooks.module";

const CRM_MODULES = [
  CrmModule,
  CrmAttentionModule,
  CrmAutomationStudioModule,
  CrmCustomFieldsModule,
  CrmInboxModule,
  CrmMetadataModule,
  CrmPricebooksModule,
];

@Module({
  imports: CRM_MODULES,
  exports: CRM_MODULES,
})
export class CrmRootModule {}
