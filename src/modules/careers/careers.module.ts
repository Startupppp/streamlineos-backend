import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/core/billing.module";
import { CareersController } from "./careers.controller";
import { CareersService } from "./careers.service";

@Module({ imports: [BillingModule], controllers: [CareersController], providers: [CareersService] })
export class CareersModule {}
