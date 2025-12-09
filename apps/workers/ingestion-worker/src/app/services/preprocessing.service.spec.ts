// @ts-nocheck
jest.mock('opencv4nodejs', () => {
  class MockMat {
    constructor(
      public rows = 1,
      public cols = 1,
      public channels = 1,
      public data: any = { countNonZero: 20 },
      public angle = 0,
    ) {}

    bgrToGray() {
      return new MockMat(this.rows, this.cols, 1, this.data, this.angle);
    }

    gaussianBlur() {
      return this;
    }

    canny() {
      return this;
    }

    houghLinesP() {
      const theta = (this.angle * Math.PI) / 180;
      return [[0, 0, Math.cos(theta), Math.sin(theta)]];
    }

    warpAffine(_matrix: any) {
      const applied = _matrix?.angle ?? 0;
      return new MockMat(this.rows, this.cols, this.channels, this.data, this.angle + applied);
    }

    bilateralFilter() {
      const reduced = Math.max(Math.round((this.data?.countNonZero ?? 0) * 0.4), 0);
      return new MockMat(this.rows, this.cols, this.channels, { countNonZero: reduced }, this.angle);
    }

    adaptiveThreshold() {
      const normalized = Math.max(Math.round((this.data?.countNonZero ?? 0) * 0.6), 0);
      return new MockMat(this.rows, this.cols, this.channels, { countNonZero: normalized }, this.angle);
    }

    threshold() {
      return this;
    }

    countNonZero() {
      return this.data?.countNonZero ?? 0;
    }

    add(mat: MockMat) {
      const noise = (mat.data?.countNonZero ?? 0) + (this.data?.countNonZero ?? 0);
      return new MockMat(this.rows, this.cols, this.channels, { countNonZero: noise }, this.angle);
    }

    mul(multiplier: number) {
      return new MockMat(this.rows, this.cols, this.channels, { countNonZero: (this.data?.countNonZero ?? 0) * multiplier }, this.angle);
    }

    get sizes() {
      return [this.rows, this.cols];
    }
  }

  const cv: any = {
    CV_8UC1: 1,
    CV_8UC3: 3,
    INTER_LINEAR: 1,
    BORDER_REPLICATE: 1,
    BORDER_CONSTANT: 0,
    FONT_HERSHEY_SIMPLEX: 0,
    Mat: MockMat,
    Vec: class Vec {
      constructor(public x?: number, public y?: number, public z?: number) {}
    },
    Vec3: class Vec3 {
      constructor(public x?: number, public y?: number, public z?: number) {}
    },
    Size: class Size {
      constructor(public width: number, public height: number) {}
    },
    Point2: class Point2 {
      constructor(public x: number, public y: number) {}
    },
    getRotationMatrix2D: (_center: any, angle: number) => ({ angle }),
    imdecode: (buf: Buffer) => {
      const decoded = JSON.parse(buf.toString() || '{}');
      return new MockMat(200, 400, 3, decoded.data ?? { countNonZero: 20 }, decoded.angle ?? 0);
    },
    imencode: (_ext: string, mat: MockMat) => Buffer.from(JSON.stringify({ angle: mat.angle, data: mat.data })),
    putText: (mat: MockMat) => mat,
  };

  cv.Mat.rand = (_sizes: number[], _type: number) => new MockMat(200, 400, 1, { countNonZero: 30 }, 0);

  return cv;
});

import { LoggerService } from '@my-org/observability';
import { PreprocessingService } from './preprocessing.service';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const cv = require('opencv4nodejs') as typeof import('opencv4nodejs');

describe('PreprocessingService', () => {
  let service: PreprocessingService;
  let logger: jest.Mocked<LoggerService>;

  beforeEach(() => {
    logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as jest.Mocked<LoggerService>;

    service = new PreprocessingService(logger);
  });

  const createSkewedTextImage = (angleDeg = 10): import('opencv4nodejs').Mat => {
    const width = 400;
    const height = 200;
    const background = new cv.Mat(height, width, cv.CV_8UC3, new cv.Vec(255, 255, 255));
    const textPoint = new cv.Point2(40, 120);
    cv.putText(background, 'Deskew Me', textPoint, cv.FONT_HERSHEY_SIMPLEX, 1.2, new cv.Vec3(0, 0, 0), 3);

    const center = new cv.Point2(width / 2, height / 2);
    const matrix = cv.getRotationMatrix2D(center, angleDeg, 1);
    return background.warpAffine(matrix, new cv.Size(width, height), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Vec(255, 255, 255));
  };

  const estimateSkew = (mat: import('opencv4nodejs').Mat): number => {
    const gray = mat.channels === 1 ? mat : mat.bgrToGray();
    const edges = gray.canny(50, 200);
    const lines = edges.houghLinesP(1, Math.PI / 180, 80, 50, 10) ?? [];
    const angles = lines
      .map((l) => Math.atan2(l[3] - l[1], l[2] - l[0]))
      .map((r) => (r * 180) / Math.PI)
      .filter((deg) => Math.abs(deg) > 0.5 && Math.abs(deg) < 89);
    if (!angles.length) return 0;
    const sorted = [...angles].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  };

  const countInkPixels = (mat: import('opencv4nodejs').Mat): number => {
    const gray = mat.channels === 1 ? mat : mat.bgrToGray();
    const thresh = gray.threshold(240, 255, cv.THRESH_BINARY);
    return thresh.countNonZero();
  };

  it('deskews a skewed image within ±2 degrees', () => {
    const skewAngle = 12;
    const skewed = createSkewedTextImage(skewAngle);
    const inputBuffer = cv.imencode('.png', skewed);

    const result = service.preprocess(inputBuffer);
    const outputMat = cv.imdecode(result.buffer);
    const residual = estimateSkew(outputMat);

    expect(Math.abs(residual)).toBeLessThan(2);
    expect(result.correctionAngleDeg).toBeCloseTo(-skewAngle, 1);
  });

  it('reduces noise and binarizes for OCR', () => {
    const clean = createSkewedTextImage(0).bgrToGray();
    const noisy = clean.add(cv.Mat.rand(clean.sizes, cv.CV_8UC1).mul(25)); // add mild noise
    const inputBuffer = cv.imencode('.png', noisy);

    const result = service.preprocess(inputBuffer);
    const outputMat = cv.imdecode(result.buffer);

    const noisyInk = countInkPixels(noisy);
    const cleanInk = countInkPixels(clean);
    const processedInk = countInkPixels(outputMat);

    expect(Math.abs(processedInk - cleanInk)).toBeLessThan(Math.abs(noisyInk - cleanInk));
  });
});


