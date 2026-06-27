import { SetMetadata } from "@nestjs/common";

export const REQUIRE_PERMISSION = "require_permission";
export const RequirePermission = (key: string) => SetMetadata(REQUIRE_PERMISSION, key);
