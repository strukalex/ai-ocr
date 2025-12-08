import { StorageService } from './storage.service';

jest.mock('minio', () => {
  return {
    Client: jest.fn().mockImplementation(() => ({
      bucketExists: jest.fn().mockResolvedValue(false),
      makeBucket: jest.fn().mockResolvedValue(undefined),
      putObject: jest.fn().mockResolvedValue(undefined),
      getObject: jest.fn().mockResolvedValue((async function* () {
        yield Buffer.from('data');
      })()),
    })),
  };
});

describe('StorageService', () => {
  const svc = new StorageService({
    endPoint: 'localhost',
    port: 9000,
    useSSL: false,
    accessKey: 'ak',
    secretKey: 'sk',
    defaultBucket: 'documents',
  });

  it('ensures bucket on upload', async () => {
    await expect(
      svc.uploadObject('file', Buffer.from('payload'), undefined, 'documents'),
    ).resolves.toBeUndefined();
  });

  it('downloads object to buffer', async () => {
    const buf = await svc.downloadObject('file', 'documents');
    expect(buf.toString()).toBe('data');
  });
});

