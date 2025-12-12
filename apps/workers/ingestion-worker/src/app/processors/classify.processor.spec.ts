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
        text: 'This is an invoice for services rendered.',
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

  it('marks documents as Classified using filename when OCR text is absent', async () => {
    prisma.document.findUnique.mockResolvedValue({
      id: 'doc-3',
      status: DocumentStatus.Uploaded,
      classificationConf: null,
      classificationType: null,
      processingProfileId: null,
    });
    prisma.document.update.mockResolvedValue({});

    await processor.handle({
      data: {
        documentId: 'doc-3',
        filename: 'invoice-filename-only.pdf',
        metadata: {},
        traceId: 'trace-3',
      },
    } as any);

    expect(prisma.document.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'doc-3' },
        data: expect.objectContaining({
          status: DocumentStatus.Classified,
          classificationType: 'invoice',
        }),
      }),
    );
  });

  it('routes unknown/low-confidence items to Exception with state reason', async () => {
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
          status: DocumentStatus.Exception,
          classificationType: 'unknown',
        }),
      }),
    );

    const updateCall = prisma.document.update.mock.calls[0]?.[0];
    expect(updateCall.data.stateReason).toContain('Unknown document type');
  });
});


