import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { ApDocumentPdfService } from './ap-document-pdf.service';
import { ApDocumentsService } from './ap-documents.service';
import { PartiesService } from '../parties/parties.service';
import { TaxService } from '../tax/tax.service';
import { StorageService } from '../../storage/storage.service';
import { DRIZZLE } from '../../../db/drizzle.constants';

describe('ApDocumentPdfService', () => {
  let service: ApDocumentPdfService;
  let documentsService: ApDocumentsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApDocumentPdfService,
        { provide: DRIZZLE, useValue: {} },
        { provide: ApDocumentsService, useValue: { get: jest.fn() } },
        { provide: PartiesService, useValue: { get: jest.fn() } },
        { provide: TaxService, useValue: { loadRegistrations: jest.fn() } },
        { provide: StorageService, useValue: { isConfigured: jest.fn().mockReturnValue(true) } },
      ],
    }).compile();

    service = module.get<ApDocumentPdfService>(ApDocumentPdfService);
    documentsService = module.get<ApDocumentsService>(ApDocumentsService);
  });

  it('should throw ConflictException if document is DRAFT', async () => {
    jest.spyOn(documentsService, 'get').mockResolvedValue({ status: 'DRAFT' } as any);
    await expect(service.render('org1', 'doc1')).rejects.toThrow(ConflictException);
  });

  it('should throw ConflictException if documentNumber is missing', async () => {
    jest.spyOn(documentsService, 'get').mockResolvedValue({ status: 'POSTED', documentNumber: null } as any);
    await expect(service.render('org1', 'doc1')).rejects.toThrow(ConflictException);
  });
});
