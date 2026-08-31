import type { UserModuleAccessService } from "../../src/modules/access/user-module-access.service";

export function makeUserModuleAccessStub(): UserModuleAccessService {
  return {
    getUserDeniedModules: jest.fn().mockResolvedValue(new Set<string>()),
    clearCacheForOrg: jest.fn(),
    getUserModuleAccess: jest.fn().mockResolvedValue([]),
    setUserModuleAccess: jest.fn().mockResolvedValue([]),
  } as unknown as UserModuleAccessService;
}
