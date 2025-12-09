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
    jest.spyOn(processor, 'extractPageText').mockImplementation(async (_pdf: PDFDocument, index: number) => {
      return ['HEADER:A Doc 1', '---SPLIT---', 'HEADER:B Doc 2'][index] ?? '';
    });

    const { parts, totalPages } = await processor.splitPdf(buffer);

    expect(totalPages).toBe(3);
    expect(parts).toHaveLength(2);
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
    jest.spyOn(processor, 'extractPageText').mockImplementation(async (_pdf: PDFDocument, index: number) => {
      return ['HEADER:Invoice A', 'HEADER:Invoice A (page 2)', 'HEADER:Invoice B'][index] ?? '';
    });

    const { parts } = await processor.splitPdf(buffer);

    expect(parts).toHaveLength(2);
    expect(await pageCountFromBuffer(parts[0])).toBe(2);
    expect(await pageCountFromBuffer(parts[1])).toBe(1);
  });

  it('falls back to single segment when no markers are present', async () => {
    const pdf = await PDFDocument.create();
    let page = pdf.addPage();
    page.drawText('HEADER:Same');
    page = pdf.addPage();
    page.drawText('HEADER:Same');

    const buffer = Buffer.from(await pdf.save());
    const processor = buildProcessor() as any;
    jest.spyOn(processor, 'extractPageText').mockImplementation(async (_pdf: PDFDocument, index: number) => {
      return ['HEADER:Same', 'HEADER:Same'][index] ?? '';
    });

    const { parts } = await processor.splitPdf(buffer);

    expect(parts).toHaveLength(1);
    expect(await pageCountFromBuffer(parts[0])).toBe(2);
  });
});

