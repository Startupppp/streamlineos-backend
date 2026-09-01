import { Injectable } from "@nestjs/common";
import { PlatformOperatorAccessService } from "../platform/platform-operator-access.service";

@Injectable()
export class CronOperatorAccessService {
  constructor(private readonly operatorAccess: PlatformOperatorAccessService) {}

  async expirePendingGrants(): Promise<{ expired: number }> {
    return { expired: await this.operatorAccess.expirePendingGrants() };
  }
}
