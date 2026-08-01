import { ForbiddenException } from "@nestjs/common";

export function moduleAccessDenied(action: "view" | "manage"): ForbiddenException {
  return new ForbiddenException(
    `You do not have permission to ${action} this module's access settings`,
  );
}
