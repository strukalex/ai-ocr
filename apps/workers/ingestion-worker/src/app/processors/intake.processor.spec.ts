import { IntakeProcessor, IntakeJobPayload } from './intake.processor';
import { AuditLogger, LoggerService } from '@my-org/observability';
import { PrismaService } from '@my-org/database';
import { DocumentStatus } from '@my-org/shared-types';
import { StorageService } from '@my-org/storage';

describe('IntakeProcessor', () => {
  let prisma: jest.Mocked<PrismaService>;
  let audit: jest.Mocked<AuditLogger>;
  let logger: jest.Mocked<LoggerService>;
  let storage: jest.Mocked<StorageService>;
  let processor: IntakeProcessor;

  beforeEach(() => {
    prisma = {
      document: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      intakeRequest: {
        updateMany: jest.fn(),
      },
    } as unknown as jest.Mocked<PrismaService>;

    audit = {
      log: jest.fn(),
    } as unknown as jest.Mocked<AuditLogger>;

    logger = {
      info: jest.fn(),
      warn: jest.fn(),
    } as unknown as jest.Mocked<LoggerService>;

    storage = {
      getDefaultBucket: jest.fn().mockReturnValue('documents'),
      objectExists: jest.fn(),
      uploadObject: jest.fn(),
      copyObject: jest.fn(),
    } as unknown as jest.Mocked<StorageService>;

    processor = new IntakeProcessor(prisma, audit, logger, storage);
  });

  it('updates document and intake request, emits audit/log', async () => {
    const payload: IntakeJobPayload = {
      documentId: 'doc-1',
      checksum: 'chk-123',
      originalUri: 'file:///tmp/sample.pdf',
      idempotencyKey: 'idem-1',
      sourceChannel: 'upload',
      traceId: 'trace-1',
      metadata: { rawContentBase64: Buffer.from('hello world').toString('base64') },
    };

    prisma.document.findUnique.mockResolvedValue({
      id: payload.documentId,
      status: DocumentStatus.Uploaded,
    } as any);
    storage.objectExists.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    await processor.handle({
      data: payload,
      id: 'job-1',
    } as any);

    expect(prisma.document.update).toHaveBeenCalledWith({
      where: { id: payload.documentId },
      data: {
        status: DocumentStatus.Uploaded,
        stateReason: null,
        originalUri: 's3://documents/originals/chk-123',
        canonicalUri: 's3://documents/canonical/chk-123.pdfa',
      },
    });

    expect(prisma.intakeRequest.updateMany).toHaveBeenCalledWith({
      where: { documentId: payload.documentId },
      data: { status: 'processed' },
    });

    expect(storage.uploadObject).toHaveBeenCalledWith(
      'originals/chk-123',
      expect.any(Buffer),
      expect.objectContaining({ 'checksum-sha256': payload.checksum }),
      'documents',
    );
    expect(storage.uploadObject).toHaveBeenCalledWith(
      'canonical/chk-123.pdfa',
      expect.any(Buffer),
      expect.objectContaining({ 'checksum-sha256': expect.any(String) }),
      'documents',
    );

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ingestion.intake_processed',
        documentId: payload.documentId,
        traceId: payload.traceId,
      }),
    );

    expect(logger.info).toHaveBeenCalledWith(
      'ingestion.intake_processed',
      expect.objectContaining({
        documentId: payload.documentId,
        checksum: payload.checksum,
        traceId: payload.traceId,
      }),
    );
  });

  it('warns and returns when document missing', async () => {
    prisma.document.findUnique.mockResolvedValue(null);

    await processor.handle({
      data: { documentId: 'missing', checksum: 'chk', originalUri: 'uri' },
      id: 'job-2',
    } as any);

    expect(logger.warn).toHaveBeenCalled();
    expect(prisma.document.update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });
});

