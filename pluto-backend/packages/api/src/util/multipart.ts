/**
 * Shared multipart / file-upload validation helpers.
 *
 * Every upload endpoint (storage, avatars, imports, admissions attachments)
 * uses these to enforce size + MIME rules consistently and to throw errors
 * that the centralized handler maps to the standard envelope:
 *
 *   - Too large        → 413  code=file_too_large       fields.file="…"
 *   - Bad MIME         → 415  code=unsupported_media_type
 *   - Empty upload     → 400  code=empty_file
 *   - Too many files   → 400  code=too_many_files
 *   - Bad file name    → 400  code=invalid_filename
 *
 * Fastify multipart's own errors (FST_REQ_FILE_TOO_LARGE etc.) are also
 * recognized by `mapError()` in `observability/errors.ts` — so raw plugin
 * errors AND thrown UploadError share the same envelope.
 */
export type UploadCode =
  | 'file_too_large'
  | 'unsupported_media_type'
  | 'empty_file'
  | 'too_many_files'
  | 'invalid_filename'
  | 'missing_file';

const STATUS_BY_CODE: Record<UploadCode, number> = {
  file_too_large: 413,
  unsupported_media_type: 415,
  empty_file: 400,
  too_many_files: 400,
  invalid_filename: 400,
  missing_file: 400,
};

const FRIENDLY_BY_CODE: Record<UploadCode, string> = {
  file_too_large: 'The uploaded file is larger than the allowed maximum.',
  unsupported_media_type: 'That file type is not supported.',
  empty_file: 'The uploaded file is empty.',
  too_many_files: 'Too many files in one request.',
  invalid_filename: 'The file name contains invalid characters.',
  missing_file: 'No file was included in the request.',
};

export class UploadError extends Error {
  statusCode: number;
  code: UploadCode;
  fields: Record<string, string>;
  detail?: string;
  constructor(code: UploadCode, opts: { field?: string; message?: string; detail?: string } = {}) {
    const field = opts.field || 'file';
    const friendly = opts.message || FRIENDLY_BY_CODE[code];
    super(friendly);
    this.name = 'UploadError';
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
    this.fields = { [field]: friendly };
    this.detail = opts.detail;
  }
}

/** RFC 6265-safe-ish filename: no path separators, no NULs, ≤255 chars. */
const FILENAME_RE = /^[^\/\\\0]{1,255}$/;

export function validateFilename(name: string, opts: { field?: string } = {}): void {
  if (!name || !FILENAME_RE.test(name)) {
    throw new UploadError('invalid_filename', {
      field: opts.field,
      detail: 'File name must be 1-255 chars and contain no path separators.',
    });
  }
}

export function validateSize(bytes: number, maxBytes: number, opts: { field?: string; filename?: string } = {}): void {
  if (bytes <= 0) throw new UploadError('empty_file', { field: opts.field });
  if (bytes > maxBytes) {
    throw new UploadError('file_too_large', {
      field: opts.field,
      message: `The uploaded file is ${(bytes / 1024 / 1024).toFixed(2)} MiB — the maximum is ${(maxBytes / 1024 / 1024).toFixed(1)} MiB.`,
      detail: opts.filename ? `filename=${opts.filename}` : undefined,
    });
  }
}

export function validateMime(
  contentType: string | undefined,
  allowed: string[] | undefined,
  opts: { field?: string } = {},
): void {
  if (!allowed || allowed.length === 0) return;
  const ct = (contentType || '').toLowerCase().split(';')[0]!.trim();
  const ok = allowed.some((a) => {
    const pat = a.toLowerCase();
    if (pat.endsWith('/*')) return ct.startsWith(pat.slice(0, -1));
    return ct === pat;
  });
  if (!ok) {
    throw new UploadError('unsupported_media_type', {
      field: opts.field,
      message: `Files of type "${ct || 'unknown'}" are not accepted. Allowed: ${allowed.join(', ')}.`,
    });
  }
}

/** All-in-one convenience validator. */
export function validateUpload(input: {
  filename?: string;
  contentType?: string;
  size: number;
  maxBytes: number;
  allowedMime?: string[];
  field?: string;
}): void {
  if (input.filename != null) validateFilename(input.filename, { field: input.field });
  validateMime(input.contentType, input.allowedMime, { field: input.field });
  validateSize(input.size, input.maxBytes, { field: input.field, filename: input.filename });
}
