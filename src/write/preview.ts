import { createHash } from 'node:crypto';

export interface PlannedChange {
  path: string;
  before: string;
  after: string;
  diff: string;
}

export function previewRevision(input: Record<string, unknown>, files: PlannedChange[]): string {
  return createHash('sha256').update(JSON.stringify({ input, files: files.map(file => ({ path: file.path, before: file.before, after: file.after })) })).digest('hex');
}
