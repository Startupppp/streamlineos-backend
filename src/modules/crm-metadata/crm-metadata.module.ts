import { Module } from "@nestjs/common";
import { CrmMetadataController } from "./crm-metadata.controller";
import { CrmDataQualityController } from "./crm-data-quality.controller";
import { CrmMetadataService } from "./crm-metadata.service";
import { CrmMetadataSeedService } from "./crm-metadata-seed.service";
import { CrmValidationService } from "./crm-validation.service";
import { CrmValidationRulesService } from "./crm-validation-rules.service";
import { CrmBlueprintsService } from "./crm-blueprints.service";
import { CrmDataQualityService } from "./crm-data-quality.service";

@Module({
  controllers: [CrmMetadataController, CrmDataQualityController],
  providers: [
    CrmMetadataService,
    CrmMetadataSeedService,
    CrmValidationService,
    CrmValidationRulesService,
    CrmBlueprintsService,
    CrmDataQualityService,
  ],
  exports: [
    CrmMetadataService,
    CrmMetadataSeedService,
    CrmValidationService,
    CrmBlueprintsService,
  ],
})
export class CrmMetadataModule {}
