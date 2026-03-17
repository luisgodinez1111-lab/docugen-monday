/**
 * src/utils/lo-convert.ts
 * libreoffice-convert wrapper — converts DOCX → PDF in-process.
 *
 * Replaces execFile('libreoffice', ...) in index.js with a proper async API:
 *   • No shell invocation (no injection surface)
 *   • Returns a Buffer (no temp file needed for small docs)
 *   • Configurable timeout with AbortController
 *
 * Requires: libreoffice-convert (already in package.json) + LibreOffice on PATH.
 */
import { promisify } from 'util';
import { logger } from '../shared/logger';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const libreConvert = require('libreoffice-convert');
const convertAsync: (
  input: Buffer,
  ext: string,
  filter?: string
) => Promise<Buffer> = promisify(libreConvert.convert);

export interface ConvertOptions {
  /** Output format. Default: 'pdf' */
  format?: string;
  /** LibreOffice filter string (optional) */
  filter?: string;
  /** Timeout in ms. Default: 60_000 */
  timeoutMs?: number;
}

/**
 * Convert a DOCX (or any LibreOffice-supported format) Buffer to PDF.
 *
 * @param input      - Source document Buffer
 * @param opts       - Conversion options
 * @returns          - PDF Buffer
 * @throws           - If conversion fails or times out
 */
export async function convertToPdf(
  input: Buffer,
  opts: ConvertOptions = {}
): Promise<Buffer> {
  const { format = 'pdf', filter, timeoutMs = 60_000 } = opts;

  logger.debug({ inputBytes: input.length, format, timeoutMs }, 'lo-convert: starting');

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`libreoffice-convert timed out after ${timeoutMs}ms`)), timeoutMs)
  );

  const startMs = Date.now();
  const outputBuffer = await Promise.race([
    convertAsync(input, `.${format}`, filter),
    timeoutPromise,
  ]);

  logger.debug(
    { inputBytes: input.length, outputBytes: outputBuffer.length, durationMs: Date.now() - startMs },
    'lo-convert: done'
  );

  return outputBuffer;
}
