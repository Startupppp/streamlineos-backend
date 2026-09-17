import { Module } from "@nestjs/common";
import { ImpersonationController } from "./impersonation.controller";
import { ImpersonationService } from "./impersonation.service";
import { AuditModule } from "../../common/audit/audit.module";
import { AuthContextModule } from "../../common/auth/auth-context.module";
import { AccessModule } from "../access/access.module";

@Module({
  imports: [AuditModule, AuthContextModule, AccessModule],
  controllers: [ImpersonationController],
  providers: [ImpersonationService],
  exports: [ImpersonationService],
})
export class ImpersonationModule {}
