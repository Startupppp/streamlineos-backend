import type {
  OrgHierarchyCacheService,
  OrgUnitListQuery,
} from "../../src/common/cache/org-hierarchy-cache.service";

export type OrgHierarchyCacheStub = Pick<
  OrgHierarchyCacheService,
  "invalidateAfterMutation" | "readUnitList" | "readUnitGet"
> & { invalidateAfterMutation: jest.Mock };

export function orgHierarchyCacheStub(): OrgHierarchyCacheStub {
  return {
    invalidateAfterMutation: jest.fn().mockResolvedValue(undefined),
    readUnitList: <T>(
      _orgId: string,
      _kind: string,
      _query: OrgUnitListQuery,
      fetcher: () => Promise<T>,
    ) => fetcher(),
    readUnitGet: <T>(
      _orgId: string,
      _kind: string,
      _id: string,
      fetcher: () => Promise<T>,
    ) => fetcher(),
  };
}
