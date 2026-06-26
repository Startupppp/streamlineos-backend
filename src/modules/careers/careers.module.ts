import { Module } from "@nestjs/common";
import { CareersController } from "./careers.controller";
import { CareersService } from "./careers.service";

@Module({ controllers: [CareersController], providers: [CareersService] })
export class CareersModule {}
