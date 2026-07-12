import { Module } from "@nestjs/common";
import { CrmMetadataController } from "./crm-metadata.controller";
import { CrmMetadataService } from "./crm-metadata.service";
import { CrmMetadataSeedService } from "./crm-metadata-seed.service";
import { CrmValidationService } from "./crm-validation.service";
import { CrmValidationRulesService } from "./crm-validation-rules.service";
import { CrmBlueprintsService } from "./crm-blueprints.service";

@Module({
  controllers: [CrmMetadataController],
  providers: [
    CrmMetadataService,
    CrmMetadataSeedService,
    CrmValidationService,
    CrmValidationRulesService,
    CrmBlueprintsService,
  ],
  exports: [
    CrmMetadataSeedService,
    CrmValidationService,
    CrmBlueprintsService,
  ],
})
export class CrmMetadataModule {}
