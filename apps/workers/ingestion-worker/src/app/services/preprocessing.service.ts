import { Injectable } from '@nestjs/common';
import { LoggerService } from '@my-org/observability';

// opencv4nodejs lacks full TS typings, keep imports runtime-safe.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cv = require('opencv4nodejs') as typeof import('opencv4nodejs');

export interface PreprocessResult {
  buffer: Buffer;
  correctionAngleDeg: number;
}

@Injectable()
export class PreprocessingService {
  constructor(private readonly logger: LoggerService) {}

  /**
   * Deskew, denoise, and binarize an image using OpenCV.
   * Returns a PNG buffer along with the applied correction angle (degrees).
   */
  preprocess(source: Buffer): PreprocessResult {
    if (!source || source.length === 0) {
      throw new Error('Empty image buffer supplied to preprocessing');
    }

    const original = cv.imdecode(source);
    const { deskewed, angle } = this.deskew(original);
    const denoised = this.denoise(deskewed);
    const binarized = this.binarize(denoised);

    return {
      buffer: cv.imencode('.png', binarized),
      correctionAngleDeg: angle,
    };
  }

  /**
   * Estimate skew via Hough transform and rotate to horizontal within tolerance.
   */
  private deskew(mat: import('opencv4nodejs').Mat): { deskewed: import('opencv4nodejs').Mat; angle: number } {
    const gray = mat.channels === 1 ? mat : mat.bgrToGray();
    const blurred = gray.gaussianBlur(new cv.Size(5, 5), 0);
    const edges = blurred.canny(50, 200);
    const lines: any = edges.houghLinesP(1, Math.PI / 180, 80, 50, 10) ?? [];

    const normalizedLines: number[][] = Array.isArray(lines)
      ? (lines as any)
      : (lines.getDataAsArray?.() ?? []).map((row: any) => row[0]);

    const angles = normalizedLines
      .map((l) => Math.atan2(l[3] - l[1], l[2] - l[0]))
      .map((radians) => (radians * 180) / Math.PI)
      // ignore near-horizontal jitter
      .filter((deg) => Math.abs(deg) > 0.5 && Math.abs(deg) < 89);

    const medianAngle = this.median(angles) ?? 0;
    const correctionAngle = -medianAngle;

    if (Math.abs(correctionAngle) < 0.5) {
      return { deskewed: mat, angle: 0 };
    }

    const center = new cv.Point2(mat.cols / 2, mat.rows / 2);
    const rotationMatrix = cv.getRotationMatrix2D(center, correctionAngle, 1);
    const rotated = mat.warpAffine(rotationMatrix, new cv.Size(mat.cols, mat.rows), cv.INTER_LINEAR, cv.BORDER_REPLICATE);

    this.logger.info('preprocess.deskew', { detectedAngle: medianAngle, appliedAngle: correctionAngle });

    return { deskewed: rotated, angle: correctionAngle };
  }

  /**
   * Reduce noise while keeping edges. Bilateral preserves text contours.
   */
  private denoise(mat: import('opencv4nodejs').Mat): import('opencv4nodejs').Mat {
    const gray = mat.channels === 1 ? mat : mat.bgrToGray();
    return gray.bilateralFilter(9, 75, 75);
  }

  /**
   * Adaptive binarization to make OCR-friendly contrast.
   */
  private binarize(mat: import('opencv4nodejs').Mat): import('opencv4nodejs').Mat {
    const gray = mat.channels === 1 ? mat : mat.bgrToGray();
    return gray.adaptiveThreshold(255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 35, 10);
  }

  private median(values: number[]): number | null {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }
}


