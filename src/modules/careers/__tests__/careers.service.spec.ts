import { Test, TestingModule } from '@nestjs/testing';
import { CareersService, isApplyJobNotFound } from '../careers.service';
import { DRIZZLE } from '../../../db/drizzle.constants';
import { CacheService } from '../../../common/cache/cache.service';
import { PlanLimitsService } from '../../billing/core/plan-limits.service';
import { RecruitmentWebhooksService } from '../../hr/recruitment/webhooks/recruitment-webhooks.service';
import { StorageService } from '../../storage/storage.service';
import { candidateApplications, candidates, jobPostings } from '../../../db/schema';
import { OutboxWriter } from '../../../common/outbox/outbox-writer';

describe('CareersService - Apply', () => {
    let service: CareersService;
    let db: any;
    let cache: any;
    let planLimits: any;

    beforeEach(async () => {
        db = {
            select: jest.fn().mockReturnThis(),
            from: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            limit: jest.fn().mockResolvedValue([{ id: 1, orgId: 'org1' }]),
            transaction: jest.fn().mockImplementation((cb: any) => cb(db)),
            execute: jest.fn().mockResolvedValue({ rowCount: 1 }),
            query: {
                candidates: { findFirst: jest.fn().mockResolvedValue(null) },
                candidateApplications: { findFirst: jest.fn().mockResolvedValue(null) },
            },
            insert: jest.fn().mockReturnThis(),
            values: jest.fn().mockReturnThis(),
            returning: jest.fn().mockResolvedValue([{ id: 1 }]),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CareersService,
                { provide: DRIZZLE, useValue: db },
                {
                    provide: CacheService,
                    useValue: { invalidateNamespace: jest.fn().mockResolvedValue(void 0) }
                },
                {
                    provide: PlanLimitsService,
                    useValue: { assertWithinLimit: jest.fn().mockResolvedValue(void 0) }
                },
                {
                    provide: RecruitmentWebhooksService,
                    useValue: { dispatch: jest.fn() }
                },
                {
                    provide: StorageService,
                    useValue: {}
                },
            ],
        }).compile();

        service = module.get<CareersService>(CareersService);
    });

    it('should successfully apply with consent', async () => {
        jest.spyOn(OutboxWriter, 'emit').mockResolvedValue(void 0);

        const result = await service.apply({
            jobPostingId: 1,
            name: 'John Doe',
            email: 'john@example.com',
            consent: true,
        });

        if (isApplyJobNotFound(result)) {
            throw new Error("expected apply() to succeed, got job_not_found");
        }
        expect(result.id).toBe(1);
        expect(db.insert).toHaveBeenCalledWith(candidateApplications);
    });
});
