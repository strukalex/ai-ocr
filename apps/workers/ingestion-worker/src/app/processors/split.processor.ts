import { Injectable } from '@nestjs/common';
import { PrismaService } from '@my-org/database';
import { AuditLogger, LoggerService } from '@my-org/observability';
import { QueueService } from '@my-org/queue';
import { DocumentStatus, SourceChannel } from '@my-org/shared-types';
import { StorageService } from '@my-org/storage';
import { Job, Queue } from 'bullmq';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import axios from 'axios';
import { basename } from 'path';
import { URL } from 'url';
import { PDFDocument } from 'pdf-lib';

export interface SplitJobPayload {
  documentId: string;
  canonicalUri: string;
  originalUri?: string;
  filename?: string;
  sourceChannel?: SourceChannel;
  traceId?: string;
}

@Injectable()
export class SplitProcessor {
  private readonly intakeQueue: Queue;
  private readonly classifyQueue: Queue;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly queueService: QueueService,
    private readonly audit: AuditLogger,
    private readonly logger: LoggerService,
  ) {
    this.intakeQueue = this.queueService.createQueue('intake');
    this.classifyQueue = this.queueService.createQueue('classify');
  }

  async handle(job: Job<SplitJobPayload>): Promise<void> {
    const payload = job.data;
    const traceId = payload.traceId ?? job.id?.toString();

    const parent = await this.prisma.document.findUnique({
      where: { id: payload.documentId },
      select: { id: true, sourceChannel: true, rootDocumentId: true },
    });

    if (!parent) {
      this.logger.warn('ingestion.split_missing_parent', {
        documentId: payload.documentId,
        canonicalUri: payload.canonicalUri,
        traceId,
      });
      return;
    }

    const documentBuffer = await this.loadDocument(payload);
    if (!documentBuffer || documentBuffer.length === 0) {
      this.logger.warn('ingestion.split_no_payload', {
        documentId: payload.documentId,
        canonicalUri: payload.canonicalUri,
        traceId,
      });
      return;
    }

    const { parts, totalPages, splitted } = await this.splitPdf(documentBuffer);

    if (!splitted) {
      await this.audit.log({
        action: 'ingestion.split_noop',
        actorId: 'system',
        outcome: 'success',
        traceId,
        documentId: payload.documentId,
        metadata: { totalPages },
      });

      this.logger.info('ingestion.split_noop', {
        documentId: payload.documentId,
        canonicalUri: payload.canonicalUri,
        traceId,
        totalPages,
      });

      await this.queueService.enqueue(
        this.classifyQueue,
        'classify',
        {
          documentId: payload.documentId,
          filename: payload.filename,
          sourceChannel: payload.sourceChannel ?? parent.sourceChannel ?? SourceChannel.WatchedStorage,
          traceId,
        },
        { jobId: `${payload.documentId}-classify` },
      );
      return;
    }

    const rootDocumentId = parent.rootDocumentId ?? parent.id;
    const childIds: string[] = [];

    for (let i = 0; i < parts.length; i++) {
      const childBuffer = parts[i];
      const checksum = this.computeSha256(childBuffer);

      const existing = await this.prisma.document.findFirst({
        where: { checksum },
        select: { id: true },
      });
      if (existing) {
        childIds.push(existing.id);
        continue;
      }

      const objectKey = `splits/${parent.id}/part-${i + 1}-${checksum}.pdf`;
      await this.storage.uploadObject(objectKey, childBuffer, {
        'checksum-sha256': checksum,
        'parent-document-id': parent.id,
        'root-document-id': rootDocumentId,
        'content-type': 'application/pdf',
      });
      const objectUri = `s3://${this.storage.getDefaultBucket()}/${objectKey}`;

      const created = await this.prisma.document.create({
        data: {
          sourceChannel: payload.sourceChannel ?? parent.sourceChannel ?? SourceChannel.WatchedStorage,
          originalUri: objectUri,
          canonicalUri: null,
          checksum,
          status: DocumentStatus.Uploaded,
          parentDocumentId: parent.id,
          rootDocumentId,
        },
        select: { id: true },
      });

      await this.prisma.intakeRequest.create({
        data: {
          documentId: created.id,
          intakeSourceId: null,
          idempotencyKey: checksum,
          status: 'received',
        },
      });

      await this.queueService.enqueue(
        this.intakeQueue,
        'intake',
        {
          documentId: created.id,
          sourceChannel: payload.sourceChannel ?? SourceChannel.WatchedStorage,
          checksum,
          originalUri: objectUri,
          filename: `${this.baseName(payload.filename ?? 'document.pdf')}-part-${i + 1}.pdf`,
          idempotencyKey: checksum,
          traceId,
        },
        { jobId: checksum },
      );

      childIds.push(created.id);
    }

    await this.prisma.document.update({
      where: { id: parent.id },
      data: {
        status: DocumentStatus.Split,
        stateReason: 'Split into child documents',
      },
    });

    await this.audit.log({
      action: 'ingestion.split_completed',
      actorId: 'system',
      outcome: 'success',
      traceId,
      documentId: parent.id,
      metadata: {
        childDocumentIds: childIds,
        totalPages,
        parts: parts.length,
      },
    });

    this.logger.info('ingestion.split_completed', {
      documentId: parent.id,
      traceId,
      parts: parts.length,
      totalPages,
    });
  }

  private async loadDocument(payload: SplitJobPayload): Promise<Buffer> {
    const uri = payload.canonicalUri ?? payload.originalUri;
    if (!uri) return Buffer.alloc(0);

    if (uri.startsWith('file://') || uri.startsWith('/')) {
      const path = uri.startsWith('file://') ? new URL(uri).pathname : uri;
      return readFile(path);
    }

    if (uri.startsWith('s3://')) {
      const parsed = new URL(uri);
      const bucket = parsed.hostname;
      const key = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
      if (bucket === this.storage.getDefaultBucket()) {
        return this.storage.downloadObject(key, bucket);
      }
    }

    if (uri.startsWith('http://') || uri.startsWith('https://')) {
      const response = await axios.get<ArrayBuffer>(uri, { responseType: 'arraybuffer' });
      return Buffer.from(response.data);
    }

    return Buffer.alloc(0);
  }

  private async splitPdf(buffer: Buffer): Promise<{ parts: Buffer[]; totalPages: number; splitted: boolean }> {
    const pdf = await PDFDocument.load(buffer);
    const totalPages = pdf.getPageCount();
    const pageTexts = await this.extractAllPageText(buffer);
    let segments = await this.detectSegments(pdf, pageTexts);
    if (totalPages > 1) {
      const coversAllPages =
        segments.length === 1 && segments[0]?.start === 0 && segments[0]?.end === totalPages - 1;

      if (segments.length === 0 || coversAllPages) {
        // Fallback: split per page when detection fails or only one contiguous segment is found.
        segments = Array.from({ length: totalPages }, (_, i) => ({ start: i, end: i }));
      }
    }

    if (segments.length === 0) {
      // Fallback: treat entire document as one part.
      const saved = await pdf.save();
      return { parts: [Buffer.from(saved)], totalPages, splitted: false };
    }

    const parts: Buffer[] = [];
    for (const segment of segments) {
      const child = await PDFDocument.create();
      const copyPages = Array.from({ length: segment.end - segment.start + 1 }, (_, i) => segment.start + i);
      const copied = await child.copyPages(pdf, copyPages);
      copied.forEach((page) => child.addPage(page));
      const saved = await child.save();
      parts.push(Buffer.from(saved));
    }

    const coversAllPages = segments.length === 1 && segments[0]?.start === 0 && segments[0]?.end === totalPages - 1;
    const shouldSplit = parts.length > 1 || totalPages > 1;
    return { parts, totalPages, splitted: shouldSplit && !coversAllPages ? true : shouldSplit };
  }

  private computeSha256(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
  }

  private baseName(filename: string): string {
    const stripped = basename(filename);
    return stripped.replace(/\.pdf$/i, '');
  }

  private async detectSegments(
    pdf: PDFDocument,
    pageTexts: string[],
  ): Promise<{ start: number; end: number; header?: string; skip?: boolean }[]> {
    const segments: { start: number; end: number; header?: string }[] = [];

    let currentStart = 0;
    let currentHeader: string | undefined;

    const pages = pdf.getPages();

    for (let idx = 0; idx < pages.length; idx++) {
      const textHint = pageTexts[idx] ?? '';

      const headerMatch = textHint.match(/HEADER:([A-Za-z0-9 _-]+)/i);
      const header = headerMatch ? headerMatch[1].trim() : undefined;
      const hasSeparatorMarker = /---SPLIT---|SPLIT\s*MARKER|SEPARATOR\s*SHEET/i.test(textHint);

      const shouldStartNew =
        idx === 0
          ? false
          : hasSeparatorMarker ||
            (currentHeader && header && header !== currentHeader) ||
            (!currentHeader && header);

      if (hasSeparatorMarker) {
        // Close prior segment before separator; separator page is not emitted.
        if (idx - 1 >= currentStart) {
          segments.push({ start: currentStart, end: idx - 1, header: currentHeader });
        }
        currentStart = idx + 1;
        // Reset header to avoid inheriting values extracted from separator sheets.
        currentHeader = undefined;
        continue;
      }

      if (shouldStartNew && currentStart < idx) {
        segments.push({ start: currentStart, end: idx - 1, header: currentHeader });
        currentStart = idx;
      }

      currentHeader = header ?? currentHeader;
    }

    if (currentStart <= pages.length - 1) {
      segments.push({ start: currentStart, end: pages.length - 1, header: currentHeader });
    }

    // Filter out any empty ranges
    return segments.filter((seg) => seg.start <= seg.end);
  }

  private async extractAllPageText(buffer: Buffer): Promise<string[]> {
    try {
      // Use pdfjs-dist for actual text extraction; pdf-lib does not support it.
      const pdfjsLib: any = await (Function(
        'return import("pdfjs-dist/legacy/build/pdf.node.mjs")',
      )() as Promise<any>);
      const pdfModule: any = pdfjsLib?.default ?? pdfjsLib;
      // Node runtime: run in-process without a separate worker to avoid workerSrc type issues.
      const loadingTask = pdfModule.getDocument({ data: new Uint8Array(buffer), disableWorker: true });
      const pdf = await loadingTask.promise;

      const texts: string[] = [];
      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        const pageText = textContent.items
          .map((item: { str?: string }) => item.str ?? '')
          .join(' ');
        texts.push(pageText);
        if (typeof page.cleanup === 'function') {
          page.cleanup();
        }
      }

      if (typeof pdf.destroy === 'function') {
        await pdf.destroy();
      }

      return texts;
    } catch (error) {
      this.logger.warn('ingestion.split_text_extraction_failed', {
        error: (error as Error).message,
      });
      return [];
    }
  }
}

