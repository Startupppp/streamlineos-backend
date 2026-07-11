import { Module } from "@nestjs/common";
import { HrTemplatesController } from "./hr-templates.controller";
import { HrTemplatesService } from "./hr-templates.service";
import { HrTemplateRenderService } from "./hr-template-render.service";

@Module({
  controllers: [HrTemplatesController],
  providers: [HrTemplatesService, HrTemplateRenderService],
  exports: [HrTemplateRenderService],
})
export class HrTemplatesModule {}
