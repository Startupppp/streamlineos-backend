import { Module } from "@nestjs/common";
import { FormsController } from "./forms.controller";
import { FormsService } from "./forms.service";
import { SubmissionsController, SubmissionsPublicController } from "./submissions.controller";
import { SubmissionsService } from "./submissions.service";
import { ProjectsModule } from "../core";

@Module({
  imports: [ProjectsModule],
  controllers: [FormsController, SubmissionsController, SubmissionsPublicController],
  providers: [FormsService, SubmissionsService],
  exports: [SubmissionsService],
})
export class BuildFormsModule {}
