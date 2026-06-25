import { Module } from "@nestjs/common";
import { TargetsController } from "./targets.controller";
import { TargetsService } from "./targets.service";

@Module({ controllers: [TargetsController], providers: [TargetsService] })
export class TargetsModule {}
