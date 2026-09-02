import { z } from "zod";
import { ADMINISTRABLE_MODULES } from "../../../common/rbac/module-vocabulary";

export const userModuleAccessParamsSchema = z.object({
  userId: z.string().trim().min(1).max(128),
}).strict();

export const setUserModuleAccessSchema = z.object({
  moduleKey: z.string().refine((key) => ADMINISTRABLE_MODULES.includes(key), "Unknown module"),
  enabled: z.boolean(),
}).strict();

export type UserModuleAccessParams = z.infer<
  typeof userModuleAccessParamsSchema
>;
export type SetUserModuleAccessInput = z.infer<
  typeof setUserModuleAccessSchema
>;
