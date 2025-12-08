import { IntakeSourcesService } from './intake-sources.service';
import { PrismaService } from '@my-org/database';
import { SourceChannel } from '@my-org/shared-types';

describe('IntakeSourcesService', () => {
  const prismaMock = {
    intakeSource: {
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  } as unknown as PrismaService;

  const service = new IntakeSourcesService(prismaMock);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists intake sources ordered by latest first', async () => {
    (prismaMock.intakeSource.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'a',
        type: SourceChannel.WatchedStorage,
        uri: 's3://bucket/path',
        credentialsRef: 'creds-1',
        pollingIntervalSeconds: 30,
        active: true,
      },
    ]);

    const result = await service.list();

    expect(prismaMock.intakeSource.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: 'desc' },
    });
    expect(result[0]).toMatchObject({
      id: 'a',
      type: SourceChannel.WatchedStorage,
      uri: 's3://bucket/path',
      credentialsRef: 'creds-1',
      pollingIntervalSeconds: 30,
      active: true,
    });
  });

  it('creates an intake source with defaults', async () => {
    (prismaMock.intakeSource.create as jest.Mock).mockResolvedValue({
      id: 'b',
      type: SourceChannel.Upload,
      uri: 'file:///tmp/upload',
      credentialsRef: null,
      pollingIntervalSeconds: null,
      active: true,
    });

    const result = await service.create({
      type: SourceChannel.Upload,
      uri: 'file:///tmp/upload',
    });

    expect(prismaMock.intakeSource.create).toHaveBeenCalledWith({
      data: {
        type: SourceChannel.Upload,
        uri: 'file:///tmp/upload',
        credentialsRef: null,
        pollingIntervalSeconds: null,
        active: true,
      },
    });
    expect(result).toEqual({
      id: 'b',
      type: SourceChannel.Upload,
      uri: 'file:///tmp/upload',
      credentialsRef: null,
      pollingIntervalSeconds: null,
      active: true,
    });
  });

  it('disables an intake source', async () => {
    (prismaMock.intakeSource.update as jest.Mock).mockResolvedValue({
      id: 'c',
      active: false,
    });

    await service.disable('c');

    expect(prismaMock.intakeSource.update).toHaveBeenCalledWith({
      where: { id: 'c' },
      data: { active: false },
    });
  });
});
