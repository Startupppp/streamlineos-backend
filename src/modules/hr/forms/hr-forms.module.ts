import { Module } from "@nestjs/common";
import { HrCoreModule } from "../core/hr-core.module";
import { HrWorkflowsModule } from "../workflows/hr-workflows.module";
import { HrFormsController } from "./hr-forms.controller";
import { HrFormsPublicController } from "./hr-forms-public.controller";
import { HrFormsService } from "./hr-forms.service";
import { HrFormsSubmissionsService } from "./hr-forms-submissions.service";

@Module({
  imports: [HrCoreModule, HrWorkflowsModule],
  controllers: [HrFormsController, HrFormsPublicController],
  providers: [HrFormsService, HrFormsSubmissionsService],
  exports: [HrFormsService],
})
export class HrFormsModule {}
