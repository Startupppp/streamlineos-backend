import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { AccessService } from "../access/access.service";
import { BuildEntityActions } from "../build/entity/build-entity.actions";
import { BuildEntityAdapter } from "../build/entity/build-entity.adapter";
import { CrmEntityAdapter } from "../crm/entity/crm-entity.adapter";
import { EntityReferenceService } from "./entity-reference.service";
import { ProjectsModule } from "../build/core";
import {
  ENTITY_ADAPTERS,
  ENTITY_MODULE_ENTITLEMENT,
  type EntityAdapter,
} from "./entity-reference.types";

@Module({
  imports: [AccessModule, ProjectsModule],
  providers: [
    BuildEntityActions,
    BuildEntityAdapter,
    CrmEntityAdapter,
    {
      provide: ENTITY_ADAPTERS,
      useFactory: (
        build: BuildEntityAdapter,
        crm: CrmEntityAdapter,
      ): EntityAdapter[] => [build, crm],
      inject: [BuildEntityAdapter, CrmEntityAdapter],
    },
    { provide: ENTITY_MODULE_ENTITLEMENT, useExisting: AccessService },
    EntityReferenceService,
  ],
  exports: [EntityReferenceService],
})
export class EntityReferenceModule {}
