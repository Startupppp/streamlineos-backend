import { Injectable, NotFoundException } from "@nestjs/common";
import { db } from "../../db";
import { courses, courseCategories, courseEnrollments } from "../../db/schema/hr/learning";
import { eq, and, desc } from "drizzle-orm";

@Injectable()
export class CoursesService {
  async listCourses(orgId: string) {
    return db.select().from(courses)
      .where(and(eq(courses.orgId, orgId)))
      .orderBy(desc(courses.createdAt))
      .limit(100);
  }

  async createCourse(orgId: string, data: typeof courses.$inferInsert) {
    const [course] = await db.insert(courses).values({ ...data, orgId }).returning();
    return course;
  }

  async updateCourse(orgId: string, id: number, data: Partial<typeof courses.$inferInsert>) {
    const [course] = await db.update(courses).set({ ...data, updatedAt: new Date() })
      .where(and(eq(courses.id, id), eq(courses.orgId, orgId))).returning();
    if (!course) throw new NotFoundException("Course not found");
    return course;
  }

  async listCategories(orgId: string) {
    return db.select().from(courseCategories).where(eq(courseCategories.orgId, orgId));
  }

  async enrollUser(courseId: number, userId: string) {
    const [enrollment] = await db.insert(courseEnrollments)
      .values({ courseId, userId }).onConflictDoNothing().returning();
    return enrollment;
  }

  async listEnrollments(userId: string) {
    return db.select().from(courseEnrollments)
      .where(eq(courseEnrollments.userId, userId))
      .orderBy(desc(courseEnrollments.createdAt))
      .limit(100);
  }

  async updateProgress(courseId: number, userId: string, progressPct: number) {
    const [e] = await db.update(courseEnrollments)
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
