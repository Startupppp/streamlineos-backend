import { HttpException, HttpStatus } from "@nestjs/common";

export class AbilityDeniedException extends HttpException {
  constructor(verb: string, subject: string) {
    super({ error: "Forbidden", code: "RBAC_DENIED", verb, subject }, HttpStatus.FORBIDDEN);
  }
}

export class ModuleDisabledException extends HttpException {
  constructor(module: string) {
    super(
      { error: "Module not available on this plan", code: "MODULE_DISABLED", module },
      HttpStatus.NOT_FOUND,
    );
  }
}
