import { Test, TestingModule } from '@nestjs/testing';
import { RecruitmentRequisitionsService } from '../recruitment-requisitions.service';
import { DRIZZLE } from '../../../../db/drizzle.constants';
import { headcountRequests } from '../../../../db/schema';
import { NotFoundException, BadRequestException } from '@nestjs/common';

describe('RecruitmentRequisitionsService - Headcount Link', () => {
    let service: RecruitmentRequisitionsService;
    let db: any;

    beforeEach(async () => {
        db = {
            select: jest.fn().mockReturnThis(),
            from: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            transaction: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                RecruitmentRequisitionsService,
                { provide: DRIZZLE, useValue: db }
            ],
        }).compile();

        service = module.get<RecruitmentRequisitionsService>(RecruitmentRequisitionsService);
    });

    it('should validate headcount link', async () => {
        db.limit.mockResolvedValueOnce([{ id: 1, status: 'APPROVED' }]);
        await expect(service['validateHeadcountLink']('org1', 1)).resolves.not.toThrow();
    });

    it('should throw if headcount not found', async () => {
        db.limit.mockResolvedValueOnce([]);
        await expect(service['validateHeadcountLink']('org1', 1)).rejects.toThrow(NotFoundException);
    });

    it('should throw if headcount not approved', async () => {
        db.limit.mockResolvedValueOnce([{ id: 1, status: 'DRAFT' }]);
        await expect(service['validateHeadcountLink']('org1', 1)).rejects.toThrow(BadRequestException);
    });

    it('should successfully create job from requisition', async () => {
        const mockRequisition = { id: 1, status: 'APPROVED', linkedJobId: null, headcount: 1, headcountId: null, title: 'Test Job' };

        // Mock findOrThrow
        jest.spyOn(service as any, 'findOrThrow').mockResolvedValue(mockRequisition);

        // Mock transaction
        db.transaction.mockImplementation((cb: any) => cb({
            insert: jest.fn().mockReturnThis(),
            values: jest.fn().mockReturnThis(),
            returning: jest.fn().mockResolvedValue([{ id: 2, title: 'Test Job' }]),
            update: jest.fn().mockReturnThis(),
            set: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
        }));

        const result = await service.createJobFromRequisition('org1', 'user1', 1);
        expect(result.jobId).toBe(2);
    });
});