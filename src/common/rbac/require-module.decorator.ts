import { SetMetadata } from "@nestjs/common";

export const REQUIRE_MODULE = "require_module";
export const RequireModule = (module: string) => SetMetadata(REQUIRE_MODULE, module);
