import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/core/billing.module";
import { HrRecruitmentModule } from "../hr/recruitment/hr-recruitment.module";
import { CareersController } from "./careers.controller";
import { CareersService } from "./careers.service";

@Module({ imports: [BillingModule, HrRecruitmentModule], controllers: [CareersController], providers: [CareersService] })
export class CareersModule {}
