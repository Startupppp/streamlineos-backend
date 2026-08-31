import { Module } from "@nestjs/common";
import { HrTemplatesController } from "./hr-templates.controller";
import { HrTemplatesService } from "./hr-templates.service";
import { HrTemplateRenderService } from "./hr-template-render.service";
import { DirectoryModule } from "../../directory/directory.module";

@Module({
  imports: [DirectoryModule],
  controllers: [HrTemplatesController],
  providers: [HrTemplatesService, HrTemplateRenderService],
  exports: [HrTemplateRenderService, HrTemplatesService],
})
export class HrTemplatesModule {}
