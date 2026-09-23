import { Module } from "@nestjs/common";
import { CareersController } from "./careers.controller";
import { CareersService } from "./careers.service";

/**
 * `StorageModule` is `@Global()`, so `StorageService` needs no import here.
 * `BillingModule` and `HrRecruitmentModule` were imported for the public apply
 * that moved to `PublicCareersService`, and are gone with it.
 */
@Module({ controllers: [CareersController], providers: [CareersService] })
export class CareersModule {}
