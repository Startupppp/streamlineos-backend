import { Global, Module } from "@nestjs/common";
import { validateEnv, type AppConfig } from "./env.validation";

export const APP_CONFIG = "APP_CONFIG";

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: (): AppConfig => validateEnv() }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
