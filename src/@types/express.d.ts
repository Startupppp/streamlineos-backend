import type { DataScope } from "../common/rbac/data-scope";

declare global {
  namespace Express {
    interface Request {
      rbacScope?: DataScope;
    }
  }
}

export {};
