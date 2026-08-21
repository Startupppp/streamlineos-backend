import { ConflictException, Injectable } from "@nestjs/common";
import { OrgHierarchyService } from "../../organization/hierarchy/org-hierarchy.service";
import { nextDepartmentCode, toDepartmentCode } from "../../organization/hierarchy/lib/department-code";

@Injectable()
export class HrDepartmentsService {
  constructor(private readonly orgHierarchy: OrgHierarchyService) {}

  async list(orgId: string) {
    const { data } = await this.orgHierarchy.listDepartments(orgId, {
      limit: 100,
      status: "ACTIVE",
    });
    return data.map((d) => ({ id: d.id, name: d.name }));
  }

  async create(orgId: string, userId: string, name: string) {
    const trimmed = name.trim();
    const base = toDepartmentCode(trimmed);
    let code = base;

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        const created = await this.orgHierarchy.createDepartment(orgId, userId, {
          name: trimmed,
          code,
        });
        return { id: created.id, name: created.name };
      } catch (err) {
        if (!(err instanceof ConflictException)) throw err;
        code = nextDepartmentCode(base, attempt + 1);
      }
    }

    throw new ConflictException("Could not generate a unique department code");
  }
}
