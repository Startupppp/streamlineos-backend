import { Module } from "@nestjs/common";
import { DrizzleModule } from "../../db/drizzle.module";
import { DelegationsController } from "./delegations.controller";
import { DelegationsService } from "./delegations.service";

@Module({
  imports: [DrizzleModule],
  controllers: [DelegationsController],
  providers: [DelegationsService],
})
export class DelegationsModule {}
