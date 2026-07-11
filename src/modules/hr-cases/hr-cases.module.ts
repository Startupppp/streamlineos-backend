import { Module } from "@nestjs/common";
import { HrCoreModule } from "../hr-core/hr-core.module";
import { HrTemplatesModule } from "../hr-templates/hr-templates.module";
import { HrCasesController } from "./hr-cases.controller";
import { HrDisciplinaryController } from "./hr-disciplinary.controller";
import { HrSafetyController } from "./hr-safety.controller";
import { HrCasesService } from "./hr-cases.service";
import { HrDisciplinaryService } from "./hr-disciplinary.service";
import { HrSafetyService } from "./hr-safety.service";

@Module({
  imports: [HrCoreModule, HrTemplatesModule],
  controllers: [HrCasesController, HrDisciplinaryController, HrSafetyController],
  providers: [HrCasesService, HrDisciplinaryService, HrSafetyService],
})
export class HrCasesModule {}
