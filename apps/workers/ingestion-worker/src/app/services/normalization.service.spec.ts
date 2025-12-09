import { NormalizationService } from './normalization.service';
import { LoggerService } from '@my-org/observability';
import { execFile } from 'child_process';
import { writeFileSync } from 'fs';

jest.mock('child_process', () => ({
  execFile: jest.fn((cmd: string, args: string[], cb: (error: any, stdout?: any, stderr?: any) => void) => {
    const outputArg = args.find((a) => a.startsWith('-sOutputFile='));
    const outputPath = outputArg?.split('=')[1];
    if (outputPath) {
      writeFileSync(outputPath, Buffer.from('pdfa-output'));
    }
    cb(null, { stdout: '', stderr: '' });
  }),
}));

describe('NormalizationService', () => {
  let service: NormalizationService;
  let logger: jest.Mocked<LoggerService>;
  const execFileMock = execFile as unknown as jest.Mock<any, any>;

  beforeEach(() => {
    logger = {
      warn: jest.fn(),
    } as unknown as jest.Mocked<LoggerService>;

    service = new NormalizationService(logger);
    execFileMock.mockClear();
  });

  it('invokes ghostscript CLI to produce PDF/A output', async () => {
    const result = await service.toPdfA(Buffer.from('input-content'), 'sample.pdf');

    expect(result.toString()).toBe('pdfa-output');
    expect(execFileMock).toHaveBeenCalled();
    const args = execFileMock.mock.calls[0][1] as string[];
    expect(args).toEqual(expect.arrayContaining(['-dPDFA=2']));
    expect(args.some((arg: string) => arg.startsWith('-sOutputFile='))).toBe(true);
    expect(args.some((arg: string) => arg.startsWith('-sOutputICCProfile='))).toBe(true);
  });

  it('propagates ghostscript failures and logs warning', async () => {
    execFileMock.mockImplementationOnce((_cmd, _args, cb) => cb(new Error('gs failed'), null));

    await expect(service.toPdfA(Buffer.from('input'), 'fail.pdf')).rejects.toThrow('gs failed');
    expect(logger.warn).toHaveBeenCalledWith(
      'normalization.pdfa_failed',
      expect.objectContaining({ error: 'gs failed' }),
    );
  });
});


