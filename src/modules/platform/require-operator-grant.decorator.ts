import { SetMetadata } from "@nestjs/common";
import type { OperatorScope } from "./platform-operator-access.service";

export const OPERATOR_GRANT_KEY = "operator:grant:scope";

export const RequireOperatorGrant = (scope: OperatorScope) =>
  SetMetadata(OPERATOR_GRANT_KEY, scope);
