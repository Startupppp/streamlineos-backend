import { Module } from "@nestjs/common";
import { PublicController } from "./public.controller";
import { RecruitmentService } from "./recruitment.service";
import { RoadmapService } from "./roadmap.service";
import { KbService } from "./kb.service";
import { CrmService } from "./crm.service";
import { IntakeService } from "./intake.service";

@Module({
  controllers: [PublicController],
  providers: [
    RecruitmentService,
    RoadmapService,
    KbService,
    CrmService,
    IntakeService,
  ],
})
export class PublicModule {}
