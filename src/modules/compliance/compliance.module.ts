import { Module } from "@nestjs/common";
import { SubprocessorsController } from "./subprocessors.controller";
import { SubprocessorsService } from "./subprocessors.service";

/**
 * Operable compliance surfaces: the things a customer's counsel reads before
 * they can buy, and a data subject uses to exercise a right.
 *
 * The register is here rather than in `settings` because it is platform data
 * describing us, not configuration belonging to a tenant.
 */
@Module({
  controllers: [SubprocessorsController],
  providers: [SubprocessorsService],
  exports: [SubprocessorsService],
})
export class ComplianceModule {}
