import { DocumentStatus } from '@my-org/shared-types';
import { ClassifyProcessor } from './classify.processor';

describe('ClassifyProcessor', () => {
  const audit = { log: jest.fn() } as any;
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
  } as any;

  const prisma = {
    document: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    processingProfile: {
      findUnique: jest.fn(),
    },
  } as any;

  let processor: ClassifyProcessor;

  beforeEach(() => {
    jest.resetAllMocks();
    processor = new ClassifyProcessor(prisma, audit, logger);
  });

  it('marks documents as Classified when confidence meets threshold', async () => {
    prisma.document.findUnique.mockResolvedValue({
      id: 'doc-1',
      status: DocumentStatus.Uploaded,
      classificationConf: null,
      classificationType: null,
      processingProfileId: null,
    });
    prisma.document.update.mockResolvedValue({});

    await processor.handle({
      data: {
        documentId: 'doc-1',
        filename: 'invoice-123.pdf',
        metadata: { submitter: 'test' },
        traceId: 'trace-1',
      },
    } as any);

    expect(prisma.document.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'doc-1' },
        data: expect.objectContaining({
          status: DocumentStatus.Classified,
          classificationType: 'invoice',
        }),
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      'ingestion.classified',
      expect.objectContaining({ documentId: 'doc-1' }),
    );
  });

  it('routes low-confidence items to PendingReview with state reason', async () => {
    prisma.document.findUnique.mockResolvedValue({
      id: 'doc-2',
      status: DocumentStatus.Uploaded,
      classificationConf: null,
      classificationType: null,
      processingProfileId: null,
    });
    prisma.document.update.mockResolvedValue({});

    await processor.handle({
      data: {
        documentId: 'doc-2',
        filename: 'mystery.bin',
        metadata: { note: 'ambiguous' },
        traceId: 'trace-2',
      },
    } as any);

    expect(prisma.document.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'doc-2' },
        data: expect.objectContaining({
          status: DocumentStatus.PendingReview,
          classificationType: 'unknown',
        }),
      }),
    );

    const updateCall = prisma.document.update.mock.calls[0]?.[0];
    expect(updateCall.data.stateReason).toContain('requires confirmation');
  });
});


