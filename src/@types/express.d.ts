import type { DataScope } from "../modules/access/access.types";

declare global {
  namespace Express {
    interface Request {
      rbacScope?: DataScope;
    }
  }
}

export {};
