import type { TempFile } from './types.ts';

export type UploadPolicy = { maxUploadMb: number; allowedUploadTypes: string[] };
export type FileCandidate = Pick<File, 'name' | 'size' | 'type'>;

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', avif: 'image/avif', svg: 'image/svg+xml', pdf: 'application/pdf',
  txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv',
  zip: 'application/zip'
};

export function attachmentMime(file: FileCandidate): string {
  const declared = file.type.toLowerCase().split(';')[0].trim();
  return (declared && declared !== 'application/octet-stream' ? declared : '') || MIME_BY_EXTENSION[file.name.split('.').pop()?.toLowerCase() ?? ''] || 'application/octet-stream';
}

export function validateAttachment(file: FileCandidate, policy?: UploadPolicy | null): string | null {
  if (!file.name.trim() || /[\u0000-\u001f\u007f]/.test(file.name)) return 'This file has an invalid name. Rename it and choose it again.';
  if (!Number.isFinite(file.size) || file.size < 0) return 'This file could not be read. Choose the original file again.';
  if (file.size === 0) return 'This file is empty. Choose a file with content.';
  const limitMb = policy?.maxUploadMb ?? 100; // The daemon never accepts a limit above 100 MiB.
  if (file.size > limitMb * 1024 * 1024) return `This file is too large. The workspace allows up to ${limitMb} MB per file.`;
  const allowed = policy?.allowedUploadTypes ?? [];
  const mime = attachmentMime(file);
  if (allowed.length && !allowed.some((pattern) => pattern.toLowerCase() === mime || (pattern.endsWith('/*') && mime.startsWith(pattern.toLowerCase().slice(0, -1))))) {
    return `This file type (${mime}) is not allowed by this workspace. Allowed types: ${allowed.join(', ')}.`;
  }
  return null;
}

/** Preview only raster formats; never execute a selected SVG/HTML document in the UI. */
export function canPreviewAttachment(file: FileCandidate): boolean {
  if (/\.(?:svgz?|html?|xhtml)$/i.test(file.name)) return false;
  return ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif'].includes(attachmentMime(file));
}

export function attachmentPrompt(text: string, files: Pick<TempFile, 'name' | 'path'>[]): string {
  if (!files.length) return text.trim();
  const references = files.map((file) => `- ${JSON.stringify(file.name)}: ${JSON.stringify(file.path)}`).join('\n');
  return `${text.trim()}${text.trim() ? '\n\n' : ''}Attached files already uploaded to this session:\n${references}`;
}
