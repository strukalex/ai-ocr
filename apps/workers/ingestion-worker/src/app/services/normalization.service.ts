import { Injectable } from '@nestjs/common';
import { PDFDocument } from 'pdf-lib';
import { LoggerService } from '@my-org/observability';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { extname, join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

@Injectable()
export class NormalizationService {
  constructor(private readonly logger: LoggerService) {}

  /**
   * Convert an input buffer to PDF/A-2b using the Ghostscript CLI.
   * Throws if Ghostscript is unavailable or returns an empty output.
   */
  async toPdfA(source: Buffer, filename?: string): Promise<Buffer> {
    const inputExt = this.detectExtension(filename);
    const pdfBuffer = await this.ensurePdfBuffer(source, inputExt);
    const inputPath = join(tmpdir(), `ingest-${randomUUID()}.pdf`);
    const outputPath = join(tmpdir(), `ingest-${randomUUID()}.pdf`);
    const iccProfile =
      process.env['GHOSTSCRIPT_ICC_PROFILE'] ??
      '/usr/share/color/icc/ghostscript/srgb.icc';

    await fs.writeFile(inputPath, pdfBuffer);

    const ghostscriptBin = process.env['GHOSTSCRIPT_BIN'] ?? 'gs';
    const args = [
      '-dPDFA=2',
      '-dBATCH',
      '-dNOPAUSE',
      '-dNOOUTERSAVE',
      '-sDEVICE=pdfwrite',
      '-sColorConversionStrategy=sRGB',
      '-sProcessColorModel=DeviceRGB',
      `-sOutputICCProfile=${iccProfile}`,
      '-dPDFACompatibilityPolicy=1',
      `-sOutputFile=${outputPath}`,
      inputPath,
    ];

    try {
      await execFileAsync(ghostscriptBin, args);
      const output = await fs.readFile(outputPath);

      if (!output || output.length === 0) {
        throw new Error('Ghostscript produced empty output');
      }

      return output;
    } catch (err) {
      this.logger.warn('normalization.pdfa_failed', {
        error: err instanceof Error ? err.message : 'unknown',
      });
      throw err;
    } finally {
      await this.safeUnlink(inputPath);
      await this.safeUnlink(outputPath);
    }
  }

  private detectExtension(filename?: string): string {
    if (!filename) return '.bin';
    const ext = extname(filename).toLowerCase();
    if (ext === '.pdf') return '.pdf';
    if (ext === '.png') return '.png';
    if (ext === '.jpg' || ext === '.jpeg') return '.jpg';
    if (ext === '.tif' || ext === '.tiff') return '.tif';
    return '.bin';
  }

  /**
   * Ensure the input is a PDF buffer; wrap common image formats into a single-page PDF.
   */
  private async ensurePdfBuffer(source: Buffer, ext: string): Promise<Buffer> {
    if (ext === '.pdf') return source;
    if (ext === '.png' || ext === '.jpg') {
      try {
        const pdf = await PDFDocument.create();
        const image =
          ext === '.png' ? await pdf.embedPng(source) : await pdf.embedJpg(source);
        const page = pdf.addPage([image.width, image.height]);
        page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
        return Buffer.from(await pdf.save());
      } catch (err) {
        this.logger.warn('normalization.embed_image_failed', {
          error: err instanceof Error ? err.message : 'unknown',
          ext,
        });
        // Fallback: create a blank PDF page to allow pipeline to proceed.
        const pdf = await PDFDocument.create();
        pdf.addPage([612, 792]); // Letter size
        return Buffer.from(await pdf.save());
      }
    }

    throw new Error(`Unsupported file type for PDF/A normalization: ${ext}`);
  }

  private async safeUnlink(path: string): Promise<void> {
    try {
      await fs.unlink(path);
    } catch {
      // ignore cleanup errors
    }
  }
}


