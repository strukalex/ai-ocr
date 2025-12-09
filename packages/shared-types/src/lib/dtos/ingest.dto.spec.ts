import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DocumentIngestRequestDto } from './ingest.dto';
import { SourceChannel } from '../enums/source-channel.enum';

describe('DocumentIngestRequestDto', () => {
  it('rejects missing required fields', async () => {
    const dto = new DocumentIngestRequestDto();
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts valid payload', async () => {
    const dto = new DocumentIngestRequestDto();
    dto.sourceChannel = SourceChannel.Upload;
    dto.originalUri = 'https://example.com/doc.pdf';
    dto.filename = 'doc.pdf';
    dto.checksum = 'abc123';
    const errors = await validate(dto);
    expect(errors.length).toBe(0);
  });

  it('rejects unsupported url protocols', async () => {
    const dto = new DocumentIngestRequestDto();
    dto.sourceChannel = SourceChannel.Upload;
    dto.originalUri = 'ftp://example.com/doc.pdf';
    dto.filename = 'doc.pdf';
    dto.checksum = 'abc123';
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts inline raw content metadata when whitelisted', async () => {
    const dto = plainToInstance(DocumentIngestRequestDto, {
      sourceChannel: SourceChannel.Upload,
      originalUri: 'https://example.com/doc.pdf',
      filename: 'doc.pdf',
      checksum: 'abc123',
      metadata: { rawContentBase64: Buffer.from('hi').toString('base64') },
    });

    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.length).toBe(0);
  });

  it('rejects unexpected metadata fields when forbidNonWhitelisted is on', async () => {
    const dto = plainToInstance(DocumentIngestRequestDto, {
      sourceChannel: SourceChannel.Upload,
      originalUri: 'https://example.com/doc.pdf',
      filename: 'doc.pdf',
      checksum: 'abc123',
      metadata: { rawContentBase64: 'abcd', extra: 'nope' },
    });

    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.length).toBeGreaterThan(0);
  });
});

