import { SetMetadata } from "@nestjs/common";
import { REQUIRE_PERMISSION } from "../../common/rbac/require-permission-key";

export { REQUIRE_PERMISSION };
export const RequirePermission = (key: string) => SetMetadata(REQUIRE_PERMISSION, key);
