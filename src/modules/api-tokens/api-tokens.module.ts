import { Module } from "@nestjs/common";
import { ApiTokensModule } from "./core/api-tokens.module";
import { UserApiTokensModule } from "./user/user-api-tokens.module";

const API_TOKENS_MODULES = [ApiTokensModule, UserApiTokensModule];

@Module({
  imports: API_TOKENS_MODULES,
  exports: API_TOKENS_MODULES,
})
export class ApiTokensRootModule {}
