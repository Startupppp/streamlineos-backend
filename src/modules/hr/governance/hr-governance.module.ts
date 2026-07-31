import { Module } from "@nestjs/common";
import { HrCoreModule } from "../core/hr-core.module";
import { LegalHoldsController } from "./legal-holds/legal-holds.controller";
import { RetentionController } from "./retention/retention.controller";
import { DelegationsController } from "./delegations/delegations.controller";
import { PositionsController } from "./positions/positions.controller";
import { LaborController } from "./labor/labor.controller";
import { LegalHoldsService } from "./legal-holds/legal-holds.service";
import { RetentionService } from "./retention/retention.service";
import { DelegationsService } from "./delegations/delegations.service";
import { PositionsService } from "./positions/positions.service";
import { LaborService } from "./labor/labor.service";

@Module({
  imports: [HrCoreModule],
  controllers: [
    LegalHoldsController,
    RetentionController,
    DelegationsController,
    PositionsController,
    LaborController,
  ],
  providers: [
    LegalHoldsService,
    RetentionService,
    DelegationsService,
    PositionsService,
    LaborService,
  ],
  exports: [LegalHoldsService],
})
export class HrGovernanceModule {}
