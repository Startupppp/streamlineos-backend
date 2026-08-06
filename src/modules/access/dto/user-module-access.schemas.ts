import { z } from "zod";
import { MODULE_CATALOG } from "../../../common/rbac/module-vocabulary";

export const userModuleAccessParamsSchema = z.object({
  userId: z.string().trim().min(1).max(128),
});

export const setUserModuleAccessSchema = z.object({
  moduleKey: z.enum(MODULE_CATALOG),
  enabled: z.boolean(),
});

export type UserModuleAccessParams = z.infer<
  typeof userModuleAccessParamsSchema
>;
export type SetUserModuleAccessInput = z.infer<
  typeof setUserModuleAccessSchema
>;
