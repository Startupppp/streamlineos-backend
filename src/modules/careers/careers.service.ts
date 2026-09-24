import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { candidates, candidateDocumentsVault } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { StorageService } from "../storage/storage.service";

/**
 * Recruiter-side résumé attachment for a candidate that already exists.
 *
 * The public apply path that used to live here moved to
 * `PublicCareersService.applyToOrgJob`, which is org-scoped. What remains is
 * authenticated, takes a candidate id, and re-asserts `orgId` on that candidate
 * before a byte is stored.
 */
@Injectable()
export class CareersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly storage: StorageService,
  ) {}

  async uploadResume(
    orgId: string,
    candidateId: number,
    userId: string,
    file: Buffer,
    fileName: string,
    mimeType: string,
  ) {
    const [candidate] = await this.db
      .select({ id: candidates.id })
      .from(candidates)
      .where(and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)))
      .limit(1);

    if (!candidate) {
      throw new BadRequestException("Candidate not found or access denied.");
    }

    const upload = await this.storage.uploadFile(orgId, file, "candidates/resumes", `${candidateId}/${fileName}`, mimeType);

    await this.db.insert(candidateDocumentsVault).values({
      candidateId,
      orgId,
      filename: fileName,
      s3Key: upload.key,
      fileUrl: upload.key, // Presumed public URL pattern
      fileType: mimeType,
      fileSize: upload.size,
      documentType: "RESUME",
      uploadedBy: userId,
    });

    return { key: upload.key };
  }

}
