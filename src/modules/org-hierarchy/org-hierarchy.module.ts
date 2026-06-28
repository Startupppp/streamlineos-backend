import { Module } from "@nestjs/common";
import { OrgHierarchyController } from "./org-hierarchy.controller";
import { OrgHierarchyService } from "./org-hierarchy.service";

@Module({
  controllers: [OrgHierarchyController],
  providers: [OrgHierarchyService],
  exports: [OrgHierarchyService],
})
export class OrgHierarchyModule {}
