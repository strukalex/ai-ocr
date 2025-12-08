import 'reflect-metadata';
import { validate } from 'class-validator';
import { DocumentStatusDto } from './lifecycle.dto';
import { DocumentStatus } from '../enums/status.enum';

describe('DocumentStatusDto', () => {
  it('rejects missing documentId', async () => {
    const dto = new DocumentStatusDto();
    dto.status = DocumentStatus.Uploaded;
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts minimal valid payload', async () => {
    const dto = new DocumentStatusDto();
    dto.documentId = 'uuid';
    dto.status = DocumentStatus.Uploaded;
    const errors = await validate(dto);
    expect(errors.length).toBe(0);
  });
});

