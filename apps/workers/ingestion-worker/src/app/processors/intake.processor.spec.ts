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
    const rawBuffer = Buffer.from('hello world');
    const rawChecksum = createHash('sha256').update(rawBuffer).digest('hex');
    const payload: IntakeJobPayload = {
      documentId: 'doc-1',
      checksum: rawChecksum,
      originalUri: 'file:///tmp/sample.pdf',
      idempotencyKey: 'idem-1',
      sourceChannel: 'upload',
      traceId: 'trace-1',
      metadata: { rawContentBase64: rawBuffer.toString('base64') },
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
        originalUri: `s3://documents/originals/${rawChecksum}`,
        canonicalUri: `s3://documents/canonical/${rawChecksum}.pdfa`,
      },
    });

    expect(prisma.intakeRequest.updateMany).toHaveBeenCalledWith({
      where: { documentId: payload.documentId },
      data: { status: 'processed' },
    });

    expect(storage.uploadObject).toHaveBeenCalledWith(
      `originals/${rawChecksum}`,
      expect.any(Buffer),
      expect.objectContaining({ 'checksum-sha256': payload.checksum }),
      'documents',
    );
    expect(storage.uploadObject).toHaveBeenCalledWith(
      `canonical/${rawChecksum}.pdfa`,
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
      checksum: '',
      originalUri: 'https://example.com/doc.pdf',
      filename: 'doc.pdf',
      sourceChannel: 'upload',
    };

    const httpBuffer = Buffer.from('remote-content');
    const httpChecksum = createHash('sha256').update(httpBuffer).digest('hex');
    payload.checksum = httpChecksum;
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
    const rawImage = Buffer.from('raw-image-bytes');
    const rawImageChecksum = createHash('sha256').update(rawImage).digest('hex');
    const payload: IntakeJobPayload = {
      documentId: 'doc-img',
      checksum: rawImageChecksum,
      originalUri: 'file:///tmp/scan.png',
      filename: 'scan.png',
      sourceChannel: 'upload',
      metadata: {
        rawContentBase64: rawImage.toString('base64'),
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
        sourceKey: `originals/${rawImageChecksum}`,
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

  it('keeps split child artifacts in splits/ without copying into originals/', async () => {
    const rawBuffer = Buffer.from('split-child-bytes');
    const rawChecksum = createHash('sha256').update(rawBuffer).digest('hex');
    const splitUri = `s3://documents/splits/parent-1/part-1-${rawChecksum}.pdf`;

    const payload: IntakeJobPayload = {
      documentId: 'child-1',
      checksum: rawChecksum,
      originalUri: splitUri,
      filename: 'part-1.pdf',
      sourceChannel: 'upload',
    };

    prisma.document.findUnique.mockResolvedValue({
      id: payload.documentId,
      originalUri: splitUri,
      status: DocumentStatus.Uploaded,
    } as any);

    jest.spyOn(processor as any, 'loadOriginalBuffer').mockResolvedValue(rawBuffer);
    jest.spyOn(processor as any, 'shouldSplit').mockResolvedValue(false);

    storage.objectExists.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const canonicalBuffer = Buffer.from('pdfa-child');
    normalization.toPdfA.mockResolvedValue(canonicalBuffer);
    const canonicalChecksum = createHash('sha256').update(canonicalBuffer).digest('hex');

    await processor.handle({ data: payload, id: 'job-child' } as any);

    expect(storage.objectExists).toHaveBeenCalledWith(
      `splits/parent-1/part-1-${rawChecksum}.pdf`,
      'documents',
    );
    expect(storage.uploadObject).not.toHaveBeenCalledWith(
      expect.stringContaining('originals/'),
      expect.any(Buffer),
      expect.anything(),
      expect.anything(),
    );
    expect(storage.uploadObject).toHaveBeenCalledWith(
      `canonical/${rawChecksum}.pdfa`,
      canonicalBuffer,
      expect.objectContaining({ 'checksum-sha256': canonicalChecksum }),
      'documents',
    );
    expect(prisma.document.update).toHaveBeenCalledWith({
      where: { id: payload.documentId },
      data: expect.objectContaining({
        originalUri: splitUri,
        canonicalUri: `s3://documents/canonical/${rawChecksum}.pdfa`,
      }),
    });
  });
});

