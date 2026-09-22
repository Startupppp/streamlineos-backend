import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { WorkloadCapacityService } from "./workload-capacity.service";
import { workloadCapacityResponseSchema } from "./dto/execution-response.schemas";
import { format, addDays } from "date-fns";

const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() }).strict();

const capacityQuerySchema = z
  .object({
    start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .strict();

type CapacityQuery = z.infer<typeof capacityQuerySchema>;

@RequireModule("build")
@Controller("build/:projectId/workload")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class WorkloadCapacityController {
  constructor(private readonly capacityService: WorkloadCapacityService) {}

  @Get("capacity")
  @RequirePermission("build:tickets:view")
  @ResponseSchema(workloadCapacityResponseSchema)
  @Validate({ params: projectIdParams, query: capacityQuerySchema })
  capacity(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query() query: CapacityQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const today = format(new Date(), "yyyy-MM-dd");
    const start = query.start ?? today;
    const end = query.end ?? format(addDays(new Date(), 13), "yyyy-MM-dd");
    return this.capacityService.capacity(u.orgId, projectId, start, end);
  }
}
