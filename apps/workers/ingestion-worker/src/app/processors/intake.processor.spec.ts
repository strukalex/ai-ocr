import 'reflect-metadata';
import { AuditLogger, LoggerService } from '@my-org/observability';
import { PrismaService } from '@my-org/database';
import { DocumentStatus } from '@my-org/shared-types';
import { StorageService } from '@my-org/storage';
import { NormalizationService } from '../services/normalization.service';
import axios from 'axios';
import { IntakeProcessor, IntakeJobPayload } from './intake.processor';
import { createHash } from 'crypto';
import { PreprocessingService } from '../services/preprocessing.service';

jest.mock('../services/preprocessing.service', () => {
  const preprocess = jest.fn((input: any) => ({
    buffer: input?.buffer ?? input,
    correctionAngleDeg: 0,
    objectKey: 'preprocess/output/mock.png',
    bucket: input?.bucket ?? 'documents',
  }));
  return {
    PreprocessingService: jest.fn().mockImplementation(() => ({
      preprocess,
    })),
  };
});

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('IntakeProcessor', () => {
  let prisma: any;
  let audit: any;
  let logger: any;
  let storage: any;
  let preprocessing: any;
  let normalization: any;
  let queueService: any;
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

    preprocessing = new (PreprocessingService as unknown as jest.Mock)();

    normalization = {
      toPdfA: jest.fn(),
    } as unknown as jest.Mocked<NormalizationService>;

    queueService = {
      createQueue: jest.fn().mockReturnValue({}),
      enqueue: jest.fn(),
    };

    processor = new IntakeProcessor(prisma, audit, logger, storage, preprocessing as any, normalization, queueService as any);
    mockedAxios.get.mockReset();
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
    const canonicalBuffer = Buffer.from('pdfa-content');
    normalization.toPdfA.mockResolvedValue(canonicalBuffer);
    const canonicalChecksum = createHash('sha256').update(canonicalBuffer).digest('hex');

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
      expect.objectContaining({ 'checksum-sha256': canonicalChecksum }),
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

  it('downloads http originals instead of writing empty content', async () => {
    const payload: IntakeJobPayload = {
      documentId: 'doc-http',
      checksum: 'chk-http',
      originalUri: 'https://example.com/doc.pdf',
      filename: 'doc.pdf',
      sourceChannel: 'upload',
    };

    const httpBuffer = Buffer.from('remote-content');
    mockedAxios.get.mockResolvedValue({ data: httpBuffer } as any);
    prisma.document.findUnique.mockResolvedValue({
      id: payload.documentId,
      originalUri: payload.originalUri,
      status: DocumentStatus.Uploaded,
    } as any);
    storage.objectExists.mockResolvedValue(true);

    await processor.handle({
      data: payload,
      id: 'job-http',
    } as any);

    expect(mockedAxios.get).toHaveBeenCalledWith(payload.originalUri, {
      responseType: 'arraybuffer',
    });
    expect(prisma.document.update).toHaveBeenCalledWith({
      where: { id: payload.documentId },
      data: expect.objectContaining({
        originalUri: payload.originalUri,
      }),
    });
    expect(storage.uploadObject).not.toHaveBeenCalled();
  });

  it('preprocesses images before normalization and records angle', async () => {
    const payload: IntakeJobPayload = {
      documentId: 'doc-img',
      checksum: 'chk-img',
      originalUri: 'file:///tmp/scan.png',
      filename: 'scan.png',
      sourceChannel: 'upload',
      metadata: {
        rawContentBase64: Buffer.from('raw-image-bytes').toString('base64'),
      },
    };

    const preprocessedBuffer = Buffer.from('processed-image-bytes');
    preprocessing.preprocess.mockReturnValue({
      buffer: preprocessedBuffer,
      correctionAngleDeg: -9.5,
      objectKey: 'preprocess/output/mock.png',
      bucket: 'documents',
    });

    prisma.document.findUnique.mockResolvedValue({
      id: payload.documentId,
      status: DocumentStatus.Uploaded,
    } as any);
    storage.objectExists.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    normalization.toPdfA.mockResolvedValue(Buffer.from('pdfa'));

    await processor.handle({ data: payload, id: 'job-img' } as any);

    expect(preprocessing.preprocess).toHaveBeenCalledWith(
      expect.objectContaining({
        buffer: expect.any(Buffer),
        sourceKey: 'originals/chk-img',
        bucket: 'documents',
      }),
    );
    expect(normalization.toPdfA).toHaveBeenCalledWith(preprocessedBuffer, payload.filename);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          preprocessingApplied: true,
          correctionAngleDeg: -9.5,
        }),
      }),
    );
  });
});

