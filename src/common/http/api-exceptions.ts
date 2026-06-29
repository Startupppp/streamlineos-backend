import { HttpException, HttpStatus } from "@nestjs/common";

export class ModuleDisabledException extends HttpException {
  constructor(module: string) {
    super(
      { error: "Module not available on this plan", code: "MODULE_DISABLED", module },
      HttpStatus.NOT_FOUND,
    );
  }
}
