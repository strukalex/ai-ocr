import { LoggerService } from '@my-org/observability';
import { PreprocessingService } from './preprocessing.service';

// This suite MUST load real opencv4nodejs; fail fast if bindings are missing.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cv = require('opencv4nodejs') as typeof import('opencv4nodejs');

describe('PreprocessingService (real OpenCV)', () => {
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

  const createTextImage = (angleDeg = 0, noisy = false): import('opencv4nodejs').Mat => {
    const width = 400;
    const height = 200;
    const background = new cv.Mat(height, width, cv.CV_8UC3);
    // fill white
    background.setTo(new (cv as any).Vec(255, 255, 255));

    const textPoint = new cv.Point2(30, 120);
    (cv as any).putText(background, 'Deskew Me', textPoint, cv.FONT_HERSHEY_SIMPLEX, 1.2, new (cv as any).Vec3(0, 0, 0), 3);

    const center = new cv.Point2(width / 2, height / 2);
    const matrix = cv.getRotationMatrix2D(center, angleDeg, 1);
    // loosen types from opencv4nodejs definitions for tests
    const rotated = (background as any).warpAffine(matrix, new cv.Size(width, height), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new (cv as any).Vec(255, 255, 255));

    if (!noisy) {
      return rotated;
    }

    const noisyMat = rotated.copy();
    for (let i = 0; i < 1200; i++) {
      const x = Math.floor(Math.random() * width);
      const y = Math.floor(Math.random() * height);
      noisyMat.set(y, x, new (cv as any).Vec3(0, 0, 0));
    }
    return noisyMat;
  };

  const estimateSkew = (mat: import('opencv4nodejs').Mat): number => {
    const gray = mat.channels === 1 ? mat : mat.bgrToGray();
    const blurred = gray.gaussianBlur(new cv.Size(5, 5), 0);
    const edges = blurred.canny(50, 200);
    const lines: any[] = (edges.houghLinesP(1, Math.PI / 180, 80, 50, 10) as any) ?? [];
    const angles = lines
      .map((l) => Math.atan2((l as any)[3] - (l as any)[1], (l as any)[2] - (l as any)[0]))
      .map((r) => (r * 180) / Math.PI)
      .filter((deg) => Math.abs(deg) > 0.5 && Math.abs(deg) < 89);
    if (!angles.length) return 0;
    const sorted = [...angles].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  };

  const inkPixels = (mat: import('opencv4nodejs').Mat): number => {
    const gray = mat.channels === 1 ? mat : mat.bgrToGray();
    const thresh = gray.threshold(240, 255, cv.THRESH_BINARY_INV);
    return thresh.countNonZero();
  };

  it('deskews a skewed noisy image within ±2° and improves binarization', () => {
    const skewAngle = 12;
    const clean = createTextImage(0, false);
    const noisySkewed = createTextImage(skewAngle, true);
    const inputBuffer = cv.imencode('.png', noisySkewed);

    const result = service.preprocess(inputBuffer);
    const processed = cv.imdecode(result.buffer);

    const residualSkew = estimateSkew(processed);
    const noisyDelta = Math.abs(inkPixels(noisySkewed) - inkPixels(clean));
    const processedDelta = Math.abs(inkPixels(processed) - inkPixels(clean));

    expect(Math.abs(residualSkew)).toBeLessThan(2);
    expect(result.correctionAngleDeg).toBeCloseTo(-skewAngle, 1);
    expect(processedDelta).toBeLessThan(noisyDelta);
  });
});



