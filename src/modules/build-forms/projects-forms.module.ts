import { Module } from "@nestjs/common";
import { FormsController } from "./forms.controller";
import { FormsService } from "./forms.service";
import { SubmissionsController } from "./submissions.controller";
import { SubmissionsService } from "./submissions.service";

@Module({
  controllers: [FormsController, SubmissionsController],
  providers: [FormsService, SubmissionsService],
})
export class ProjectsFormsModule {}
