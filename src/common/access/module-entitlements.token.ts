export const MODULE_ENTITLEMENTS = Symbol("MODULE_ENTITLEMENTS");

export interface IModuleEntitlements {
  isModuleEnabled(orgId: string, moduleKey: string): Promise<boolean>;
}
