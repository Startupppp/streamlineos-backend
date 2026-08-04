import { SetMetadata } from "@nestjs/common";

export const REQUIRE_MODULE = "require_module";
export const RequireModule = (module: string | readonly string[]) =>
  SetMetadata(REQUIRE_MODULE, module);
