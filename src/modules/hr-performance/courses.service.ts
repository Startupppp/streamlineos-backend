import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { courses, courseCategories, courseEnrollments } from "../../db/schema/hr/learning";
import { eq, and, desc } from "drizzle-orm";
import { HrAutomationEngineService } from "../hr-automations/hr-automation-engine.service";

@Injectable()
export class CoursesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly hrAutomation: HrAutomationEngineService,
  ) {}

  async listCourses(orgId: string) {
    return this.db.select().from(courses)
      .where(and(eq(courses.orgId, orgId)))
      .orderBy(desc(courses.createdAt))
      .limit(100);
  }

  async createCourse(orgId: string, data: Omit<typeof courses.$inferInsert, "orgId">) {
    const [course] = await this.db.insert(courses).values({ ...data, orgId }).returning();
    return course;
  }

  async updateCourse(orgId: string, id: number, data: Partial<Omit<typeof courses.$inferInsert, "orgId">>) {
    const [course] = await this.db.update(courses).set({ ...data, updatedAt: new Date() })
      .where(and(eq(courses.id, id), eq(courses.orgId, orgId))).returning();
    if (!course) throw new NotFoundException("Course not found");
    return course;
  }

  async listCategories(orgId: string) {
    return this.db.select().from(courseCategories).where(eq(courseCategories.orgId, orgId));
  }

  private async ensureCourse(orgId: string, courseId: number) {
    const [course] = await this.db
      .select({ id: courses.id })
      .from(courses)
      .where(and(eq(courses.id, courseId), eq(courses.orgId, orgId)))
      .limit(1);
    if (!course) throw new NotFoundException("Course not found");
  }

  async enrollUser(orgId: string, courseId: number, userId: string) {
    await this.ensureCourse(orgId, courseId);
    const [enrollment] = await this.db.insert(courseEnrollments)
      .values({ courseId, userId }).onConflictDoNothing().returning();
    return enrollment;
  }

  async assignCourse(orgId: string, userId: string, courseId: number, source: string) {
    const enrollment = await this.enrollUser(orgId, courseId, userId);
    if (enrollment) {
      void this.hrAutomation.emit(orgId, "course.assigned", {
        userId,
        courseId,
        source,
        enrollmentId: enrollment.id,
      });
    }
    return enrollment;
  }

  async listEnrollments(orgId: string, userId: string) {
    return this.db
      .select({
        id: courseEnrollments.id,
        courseId: courseEnrollments.courseId,
        userId: courseEnrollments.userId,
        status: courseEnrollments.status,
        progressPct: courseEnrollments.progressPct,
        completedAt: courseEnrollments.completedAt,
        score: courseEnrollments.score,
        createdAt: courseEnrollments.createdAt,
      })
      .from(courseEnrollments)
      .innerJoin(courses, eq(courseEnrollments.courseId, courses.id))
      .where(and(eq(courses.orgId, orgId), eq(courseEnrollments.userId, userId)))
      .orderBy(desc(courseEnrollments.createdAt))
      .limit(100);
  }

  async updateProgress(orgId: string, courseId: number, userId: string, progressPct: number) {
    await this.ensureCourse(orgId, courseId);
    const [e] = await this.db.update(courseEnrollments)
      .set({
        progressPct: progressPct.toString(),
        status: progressPct >= 100 ? "COMPLETED" : "IN_PROGRESS",
        completedAt: progressPct >= 100 ? new Date() : null,
      })
      .where(and(eq(courseEnrollments.courseId, courseId), eq(courseEnrollments.userId, userId)))
      .returning();
    return e;
  }
}
