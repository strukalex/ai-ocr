import 'reflect-metadata';
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
});

