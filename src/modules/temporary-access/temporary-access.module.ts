import { Module } from "@nestjs/common";
import { DrizzleModule } from "../../db/drizzle.module";
import { TemporaryAccessController } from "./temporary-access.controller";
import { TemporaryAccessService } from "./temporary-access.service";

@Module({
  imports: [DrizzleModule],
  controllers: [TemporaryAccessController],
  providers: [TemporaryAccessService],
})
export class TemporaryAccessModule {}
