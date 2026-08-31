import { SetMetadata } from "@nestjs/common";

export const AUTHORIZED_IN_SERVICE = "authorizedInService";

/**
 * Declares that a route is authorized downstream of the guard, and names what
 * does it.
 *
 * The three-way public/universal/permissioned vocabulary is not quite the whole
 * truth. The module-access surface authorizes through
 * `assertModuleAccessPolicy`, which resolves module management *standing* — and
 * standing is not expressible as a permission key. `backend/CLAUDE.md` §5 is
 * explicit that a custom or delegated `<module>:access:manage` grant is
 * view-only and never creates management authority, so putting a
 * `@RequirePermission` on those routes would not merely be redundant, it would
 * advertise a second and weaker way in.
 *
 * Without this, those routes read as undeclared, and the honest options were
 * both wrong: mark them `@Universal()` and claim an administration surface is
 * platform core, or leave the classifier permanently unenforceable.
 *
 * The `by` argument is required and is the point. This is a declaration of where
 * the check lives, not an exemption from having one — a route that names nothing
 * cannot use this decorator, and a reviewer can follow the name to the check.
 */
export const AuthorizedInService = (by: string): MethodDecorator & ClassDecorator =>
  SetMetadata(AUTHORIZED_IN_SERVICE, by);
