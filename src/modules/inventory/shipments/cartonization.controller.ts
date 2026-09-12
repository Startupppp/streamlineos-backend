import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { CartonizationService } from "./cartonization.service";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { suggestCartonResponseSchema } from "./dto/shipments-response.schemas";

const suggestCartonSchema = z
  .object({
    lines: z
      .array(
        z
          .object({
            productVariantId: z.number().int().positive(),
            quantity: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();
type SuggestCartonInput = z.infer<typeof suggestCartonSchema>;

@RequireModule("inventory")
@Controller("inventory/cartonization")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class CartonizationController {
  constructor(private readonly cartonization: CartonizationService) {}

  /**
   * INV-206. Advisory. It reports what plausibly fits and why anything does
   * not; it does not claim to have solved three-dimensional packing.
   */
  @Post("suggest")
  @ResponseSchema(suggestCartonResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:shipments:manage")
  suggest(
    @Body(new ZodValidationPipe(suggestCartonSchema)) body: SuggestCartonInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.cartonization.suggest(u.orgId, body.lines);
  }
}
