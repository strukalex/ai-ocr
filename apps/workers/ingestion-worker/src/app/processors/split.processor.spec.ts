// @ts-nocheck
import { SplitProcessor } from './split.processor';
import { PDFDocument } from 'pdf-lib';

function buildProcessor(): SplitProcessor {
  const prisma = {} as any;
  const storage = {} as any;
  const queueService = { createQueue: () => ({ add: jest.fn() }) } as any;
  const audit = { log: jest.fn() } as any;
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;

  return new SplitProcessor(prisma, storage, queueService, audit, logger);
}

async function pageCountFromBuffer(buffer: Buffer): Promise<number> {
  const pdf = await PDFDocument.load(buffer);
  return pdf.getPageCount();
}

describe('SplitProcessor heuristics', () => {
  it('splits on explicit separator sheet marker and drops separator page', async () => {
    const pdf = await PDFDocument.create();
    let page = pdf.addPage();
    page.drawText('HEADER:A Doc 1');

    page = pdf.addPage();
    page.drawText('---SPLIT---');

    page = pdf.addPage();
    page.drawText('HEADER:B Doc 2');

    const buffer = Buffer.from(await pdf.save());
    const processor = buildProcessor() as any;
    jest
      .spyOn(processor, 'extractAllPageText')
      .mockResolvedValue(['HEADER:A Doc 1', '---SPLIT---', 'HEADER:B Doc 2']);

    const { parts, totalPages, splitted } = await processor.splitPdf(buffer);

    expect(totalPages).toBe(3);
    expect(parts).toHaveLength(2);
    expect(splitted).toBe(true);
    expect(await pageCountFromBuffer(parts[0])).toBe(1);
    expect(await pageCountFromBuffer(parts[1])).toBe(1);
  });

  it('splits when header text changes across pages', async () => {
    const pdf = await PDFDocument.create();
    let page = pdf.addPage();
    page.drawText('HEADER:Invoice A');
    page = pdf.addPage();
    page.drawText('HEADER:Invoice A (page 2)');
    page = pdf.addPage();
    page.drawText('HEADER:Invoice B');

    const buffer = Buffer.from(await pdf.save());
    const processor = buildProcessor() as any;
    jest
      .spyOn(processor, 'extractAllPageText')
      .mockResolvedValue(['HEADER:Invoice A', 'HEADER:Invoice A (page 2)', 'HEADER:Invoice B']);

    const { parts, splitted } = await processor.splitPdf(buffer);

    expect(parts).toHaveLength(2);
    expect(splitted).toBe(true);
    expect(await pageCountFromBuffer(parts[0])).toBe(2);
    expect(await pageCountFromBuffer(parts[1])).toBe(1);
  });

  it('falls back to per-page segments when no markers are present', async () => {
    const pdf = await PDFDocument.create();
    let page = pdf.addPage();
    page.drawText('HEADER:Same');
    page = pdf.addPage();
    page.drawText('HEADER:Same');

    const buffer = Buffer.from(await pdf.save());
    const processor = buildProcessor() as any;
    jest.spyOn(processor, 'extractAllPageText').mockResolvedValue(['HEADER:Same', 'HEADER:Same']);

    const { parts, splitted } = await processor.splitPdf(buffer);

    expect(parts).toHaveLength(2);
    expect(splitted).toBe(true);
    expect(await pageCountFromBuffer(parts[0])).toBe(1);
  });
});

describe('SplitProcessor handle', () => {
  it('enqueues classification and skips child creation when no split is needed', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    pdf.addPage();
    const buffer = Buffer.from(await pdf.save());

    const intakeQueue = { name: 'intake' };
    const classifyQueue = { name: 'classify' };

    const queueService = {
      createQueue: jest
        .fn()
        .mockReturnValueOnce(intakeQueue)
        .mockReturnValueOnce(classifyQueue),
      enqueue: jest.fn(),
    } as any;

    const prisma = {
      document: {
        findUnique: jest.fn().mockResolvedValue({ id: 'doc-1', sourceChannel: 'upload', rootDocumentId: null }),
      },
    } as any;

    const processor = new SplitProcessor(
      prisma,
      { getDefaultBucket: jest.fn() } as any,
      queueService,
      { log: jest.fn() } as any,
      { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
    ) as any;

    jest.spyOn(processor, 'loadDocument').mockResolvedValue(buffer);
    jest.spyOn(processor, 'splitPdf').mockResolvedValue({ parts: [buffer], totalPages: 2, splitted: false });

    await processor.handle({
      data: {
        documentId: 'doc-1',
        canonicalUri: 's3://documents/canonical/doc-1.pdfa',
        filename: 'doc-1.pdf',
        sourceChannel: 'upload',
        traceId: 'trace-1',
      },
    } as any);

    expect(queueService.enqueue).toHaveBeenCalledTimes(1);
    expect(queueService.enqueue).toHaveBeenCalledWith(
      classifyQueue,
      'classify',
      expect.objectContaining({ documentId: 'doc-1', filename: 'doc-1.pdf', sourceChannel: 'upload' }),
      { jobId: 'doc-1-classify' },
    );
  });
});

