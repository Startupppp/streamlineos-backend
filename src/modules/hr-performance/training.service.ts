import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { trainingPrograms, trainingAttendance } from "../../db/schema/hr/training";
import { eq, and, desc } from "drizzle-orm";

type ProgramInsert = typeof trainingPrograms.$inferInsert;
type AttendanceInsert = typeof trainingAttendance.$inferInsert;

@Injectable()
export class TrainingService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listPrograms(orgId: string) {
    return this.db.select().from(trainingPrograms)
      .where(eq(trainingPrograms.orgId, orgId))
      .orderBy(desc(trainingPrograms.createdAt))
      .limit(100);
  }

  async createProgram(orgId: string, data: Omit<ProgramInsert, "id" | "orgId" | "createdAt">) {
    const [program] = await this.db.insert(trainingPrograms).values({ ...data, orgId }).returning();
    return program;
  }

  async updateProgram(orgId: string, id: number, data: Partial<Omit<ProgramInsert, "id" | "orgId" | "createdAt">>) {
    const [program] = await this.db.update(trainingPrograms).set(data)
      .where(and(eq(trainingPrograms.id, id), eq(trainingPrograms.orgId, orgId))).returning();
    if (!program) throw new NotFoundException("Training program not found");
    return program;
  }

  async listAttendance(programId: number) {
    return this.db.select().from(trainingAttendance)
      .where(eq(trainingAttendance.programId, programId))
      .orderBy(trainingAttendance.createdAt)
      .limit(200);
  }

  async enrollUser(programId: number, userId: string) {
    const existing = await this.db.select().from(trainingAttendance)
      .where(and(eq(trainingAttendance.programId, programId), eq(trainingAttendance.userId, userId)));
    if (existing.length > 0) return existing[0];
    const [attendance] = await this.db.insert(trainingAttendance).values({ programId, userId }).returning();
    return attendance;
  }

  async markAttendance(programId: number, userId: string, data: Partial<Omit<AttendanceInsert, "id" | "programId" | "userId" | "createdAt">>) {
    const [attendance] = await this.db.update(trainingAttendance).set(data)
      .where(and(eq(trainingAttendance.programId, programId), eq(trainingAttendance.userId, userId)))
      .returning();
    if (!attendance) throw new NotFoundException("Attendance record not found");
    return attendance;
  }
}
