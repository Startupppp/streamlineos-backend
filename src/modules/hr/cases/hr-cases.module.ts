import { Module } from "@nestjs/common";
import { HrCoreModule } from "../core/hr-core.module";
import { HrTemplatesModule } from "../templates/hr-templates.module";
import { HrCasesController } from "./hr-cases.controller";
import { HrDisciplinaryController } from "./hr-disciplinary.controller";
import { HrSafetyController } from "./hr-safety.controller";
import { ServiceDeliveryController } from "./service-delivery.controller";
import { HrCasesService } from "./hr-cases.service";
import { HrDisciplinaryService } from "./hr-disciplinary.service";
import { HrSafetyService } from "./hr-safety.service";
import { ServiceDeliveryInboxService } from "./service-delivery-inbox.service";

@Module({
  imports: [HrCoreModule, HrTemplatesModule],
  controllers: [
    HrCasesController,
    HrDisciplinaryController,
    HrSafetyController,
    ServiceDeliveryController,
  ],
  providers: [
    HrCasesService,
    HrDisciplinaryService,
    HrSafetyService,
    ServiceDeliveryInboxService,
  ],
  exports: [ServiceDeliveryInboxService],
})
export class HrCasesModule {}
