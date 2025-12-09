import { StorageService } from './storage.service';

const mockClient = {
  bucketExists: jest.fn().mockResolvedValue(false),
  makeBucket: jest.fn().mockResolvedValue(undefined),
  putObject: jest.fn().mockResolvedValue(undefined),
  getObject: jest.fn().mockResolvedValue(
    (async function* () {
      yield Buffer.from('data');
    })(),
  ),
};

jest.mock('minio', () => ({
  Client: jest.fn().mockImplementation(() => mockClient),
}));

describe('StorageService', () => {
  beforeEach(() => jest.clearAllMocks());

  const svc = new StorageService({
    endPoint: 'localhost',
    port: 9000,
    useSSL: false,
    accessKey: 'ak',
    secretKey: 'sk',
    defaultBucket: 'documents',
    enforceSse: true,
    sseAlgorithm: 'AES256',
  });

  it('ensures bucket on upload', async () => {
    await expect(
      svc.uploadObject('file', Buffer.from('payload'), undefined, 'documents'),
    ).resolves.toBeUndefined();
    expect(mockClient.bucketExists).toHaveBeenCalledWith('documents');
    expect(mockClient.makeBucket).toHaveBeenCalledWith('documents');
  });

  it('downloads object to buffer', async () => {
    const buf = await svc.downloadObject('file', 'documents');
    expect(buf.toString()).toBe('data');
  });

  it('applies SSE metadata when enforced', async () => {
    await svc.uploadObject('file', Buffer.from('payload'));
    const putCall = mockClient.putObject.mock.calls[0];
    expect(putCall[4]).toMatchObject({
      'x-amz-server-side-encryption': 'AES256',
    });
  });

  it('allows disabling SSE enforcement explicitly', async () => {
    const nonSse = new StorageService({
      endPoint: 'localhost',
      enforceSse: false,
      useSSL: false,
    } as any);

    await nonSse.uploadObject('file', Buffer.from('payload'));
    const putCall = mockClient.putObject.mock.calls.find(
      (call) => call[0] === 'documents' && call[1] === 'file',
    );
    expect(putCall?.[4]).toBeUndefined();
  });
});

