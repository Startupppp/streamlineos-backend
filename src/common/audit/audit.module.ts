import { Global, Module } from "@nestjs/common";
import { AuditService } from "./audit.service";
import { InternalAuditController } from "./internal-audit.controller";

@Global()
@Module({
  controllers: [InternalAuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
