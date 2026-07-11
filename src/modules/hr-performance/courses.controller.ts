import { Controller, Get, Post, Patch, Body, Param, ParseIntPipe, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CoursesService } from "./courses.service";

@RequireModule("hr")
@Controller("hr/courses")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CoursesController {
  constructor(private readonly courses: CoursesService) {}

  @Get("categories")
  @RequirePermission("hr:learning:view")
  listCategories(@CurrentUser() u: CurrentUserContext) {
    return this.courses.listCategories(u.orgId);
  }

  @Get("my-enrollments")
  @RequirePermission("hr:learning:view")
  myEnrollments(@CurrentUser() u: CurrentUserContext) {
    return this.courses.listEnrollments(u.userId);
  }

  @Get()
  @RequirePermission("hr:learning:view")
  listCourses(@CurrentUser() u: CurrentUserContext) {
    return this.courses.listCourses(u.orgId);
  }

  @Post()
  @RequirePermission("hr:learning:manage")
  createCourse(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: Record<string, unknown>,
  ) {
    return this.courses.createCourse(u.orgId, body as Parameters<CoursesService["createCourse"]>[1]);
  }

  @Patch(":courseId")
  @RequirePermission("hr:learning:manage")
  updateCourse(
    @CurrentUser() u: CurrentUserContext,
    @Param("courseId", ParseIntPipe) courseId: number,
    @Body() body: Record<string, unknown>,
  ) {
    return this.courses.updateCourse(u.orgId, courseId, body as Parameters<CoursesService["updateCourse"]>[2]);
  }

  @Post(":courseId/enroll")
  @RequirePermission("hr:learning:view")
  enroll(
    @CurrentUser() u: CurrentUserContext,
    @Param("courseId", ParseIntPipe) courseId: number,
  ) {
    return this.courses.enrollUser(courseId, u.userId);
  }

  @Patch(":courseId/progress")
  @RequirePermission("hr:learning:view")
  updateProgress(
    @CurrentUser() u: CurrentUserContext,
    @Param("courseId", ParseIntPipe) courseId: number,
    @Body("progressPct") pct: number,
  ) {
    return this.courses.updateProgress(courseId, u.userId, pct);
  }
}
