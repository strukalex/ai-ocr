import { PrismaService } from './prisma.service';

jest.mock('@prisma/client', () => {
  class MockPrismaClient {
    $connect = jest.fn();
    $disconnect = jest.fn();
  }
  return { PrismaClient: MockPrismaClient };
});

describe('PrismaService', () => {
  it('connects and disconnects', async () => {
    const svc = new PrismaService();
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
    await expect(svc.onModuleDestroy()).resolves.toBeUndefined();
  });
});

