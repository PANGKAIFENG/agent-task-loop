import mammoth from 'mammoth';
import { Buffer } from 'node:buffer';
import type { Readable } from 'node:stream';
import JSZip from 'jszip';
import * as PDFJS from 'unpdf/pdfjs';

export const MAX_MEETING_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const MAX_MEETING_DOCUMENT_CHARACTERS = 100_000;
export const MAX_MEETING_DOCX_EXPANDED_BYTES = 64 * 1024 * 1024;
export const MAX_MEETING_PDF_PAGES = 500;
export const MAX_MEETING_PDF_TEXT_ITEMS = 100_000;

export type MeetingDocumentKind = 'txt' | 'md' | 'docx' | 'pdf';

export interface MeetingDocumentInput {
  name: string;
  data: Uint8Array;
}

export interface MeetingDocumentParserDependencies {
  extractDocx(data: Uint8Array): Promise<string>;
  extractPdf(data: Uint8Array): Promise<string>;
}

export type MeetingDocumentParser = (
  input: MeetingDocumentInput,
) => Promise<string>;

interface PdfTextItem {
  str: string;
  hasEOL: boolean;
}

interface PdfTextDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<{
    streamTextContent(): ReadableStream<{ items: unknown[] }>;
  }>;
}

interface PdfDocumentProxy extends PdfTextDocument {
  destroy(): Promise<void>;
}

export interface MeetingDocxExtractorDependencies {
  expandedSize(data: Uint8Array): Promise<number>;
  extractRawText(data: Uint8Array): Promise<string>;
}

const getPdfDocument = (PDFJS as unknown as {
  getDocument(options: {
    data: Uint8Array;
    disableFontFace: boolean;
    isEvalSupported: boolean;
    useSystemFonts: boolean;
  }): { promise: Promise<PdfDocumentProxy> };
}).getDocument;

function isPdfTextItem(value: unknown): value is PdfTextItem {
  return value !== null
    && typeof value === 'object'
    && 'str' in value
    && typeof value.str === 'string'
    && 'hasEOL' in value
    && typeof value.hasEOL === 'boolean';
}

function documentTooLongError(maximumCharacters = MAX_MEETING_DOCUMENT_CHARACTERS): Error {
  return new Error(
    `解析后文本不能超过 ${maximumCharacters.toLocaleString('en-US')} 个字符`,
  );
}

export async function extractMeetingPdfText(
  document: PdfTextDocument,
  limits: {
    maximumPages?: number;
    maximumTextItems?: number;
    maximumCharacters?: number;
  } = {},
): Promise<string> {
  const maximumPages = limits.maximumPages ?? MAX_MEETING_PDF_PAGES;
  const maximumTextItems = limits.maximumTextItems ?? MAX_MEETING_PDF_TEXT_ITEMS;
  const maximumCharacters = limits.maximumCharacters ?? MAX_MEETING_DOCUMENT_CHARACTERS;
  if (!Number.isSafeInteger(document.numPages) || document.numPages < 0) {
    throw new Error('PDF 页数无效');
  }
  if (document.numPages > maximumPages) {
    throw new Error(`PDF 不能超过 ${maximumPages.toLocaleString('en-US')} 页`);
  }
  const pages: string[] = [];
  let characterCount = 0;
  let textItemCount = 0;
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const pageParts: string[] = [];
    if (pages.length > 0) characterCount += 1;
    const reader = page.streamTextContent().getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (chunk.value.items.length > maximumTextItems - textItemCount) {
          try {
            await reader.cancel();
          } catch {
            // Preserve the stable resource-limit error if PDF.js cancellation fails.
          }
          throw new Error(
            `PDF 文本项不能超过 ${maximumTextItems.toLocaleString('en-US')} 个`,
          );
        }
        textItemCount += chunk.value.items.length;
        for (const item of chunk.value.items) {
          if (!isPdfTextItem(item)) continue;
          const part = `${item.str}${item.hasEOL ? '\n' : ''}`;
          characterCount += part.length;
          if (characterCount > maximumCharacters) {
            try {
              await reader.cancel();
            } catch {
              // Preserve the stable resource-limit error if PDF.js cancellation fails.
            }
            throw documentTooLongError(maximumCharacters);
          }
          pageParts.push(part);
        }
      }
    } finally {
      reader.releaseLock();
    }
    pages.push(pageParts.join(''));
  }
  return pages.join('\n').replace(/\s+/gu, ' ');
}

function docxExpandedTooLargeError(maximumBytes: number): Error {
  const label = maximumBytes === MAX_MEETING_DOCX_EXPANDED_BYTES
    ? '64 MiB'
    : `${maximumBytes.toLocaleString('en-US')} bytes`;
  return new Error(`DOCX 解压后内容不能超过 ${label}`);
}

export async function docxExpandedSize(
  data: Uint8Array,
  maximumBytes = MAX_MEETING_DOCX_EXPANDED_BYTES,
): Promise<number> {
  const archive = await JSZip.loadAsync(data);
  let total = 0;
  for (const entry of Object.values(archive.files)) {
    if (entry.dir) continue;
    await new Promise<void>((resolve, reject) => {
      const stream = entry.nodeStream('nodebuffer') as Readable;
      let settled = false;
      stream.on('data', (chunk: Buffer) => {
        if (settled) return;
        total += chunk.byteLength;
        if (!Number.isSafeInteger(total)) {
          settled = true;
          stream.destroy();
          reject(new Error('DOCX 解压后大小无效'));
          return;
        }
        if (total > maximumBytes) {
          settled = true;
          stream.destroy();
          reject(docxExpandedTooLargeError(maximumBytes));
        }
      });
      stream.on('error', (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      stream.on('end', () => {
        if (settled) return;
        settled = true;
        resolve();
      });
    });
  }
  return total;
}

export function createMeetingDocxExtractor(
  dependencies: MeetingDocxExtractorDependencies,
): (data: Uint8Array) => Promise<string> {
  return async (data) => {
    const expandedSize = await dependencies.expandedSize(data);
    if (expandedSize > MAX_MEETING_DOCX_EXPANDED_BYTES) {
      throw docxExpandedTooLargeError(MAX_MEETING_DOCX_EXPANDED_BYTES);
    }
    return dependencies.extractRawText(data);
  };
}

export function meetingDocumentKind(name: string): MeetingDocumentKind | null {
  const match = /\.([^.]+)$/u.exec(name.trim());
  if (match === null) return null;
  const extension = match[1]?.toLocaleLowerCase('en-US');
  return extension === 'txt'
    || extension === 'md'
    || extension === 'docx'
    || extension === 'pdf'
    ? extension
    : null;
}

export function assertMeetingDocumentSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error('文件大小无效');
  }
  if (size > MAX_MEETING_ATTACHMENT_BYTES) {
    throw new Error('单个附件不能超过 50 MiB');
  }
}

function validatedText(value: string): string {
  const normalized = value.startsWith('\uFEFF') ? value.slice(1) : value;
  if (normalized.length > MAX_MEETING_DOCUMENT_CHARACTERS) {
    throw documentTooLongError();
  }
  if (normalized.trim() === '') {
    throw new Error('文件没有可分析文本');
  }
  return normalized;
}

export function createMeetingDocumentParser(
  dependencies: MeetingDocumentParserDependencies,
): MeetingDocumentParser {
  return async (input) => {
    assertMeetingDocumentSize(input.data.byteLength);
    const kind = meetingDocumentKind(input.name);
    if (kind === null) {
      throw new Error('暂不支持解析此文件格式');
    }

    if (kind === 'txt' || kind === 'md') {
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(input.data);
      } catch {
        throw new Error('文本文件必须使用 UTF-8 编码');
      }
      return validatedText(text);
    }

    const text = kind === 'docx'
      ? await dependencies.extractDocx(input.data)
      : await dependencies.extractPdf(input.data);
    return validatedText(text);
  };
}

const extractMeetingDocxText = createMeetingDocxExtractor({
  expandedSize: docxExpandedSize,
  extractRawText: async (data) => {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(data) });
    return result.value;
  },
});

export const parseMeetingDocument = createMeetingDocumentParser({
  extractDocx: extractMeetingDocxText,
  extractPdf: async (data) => {
    const document = await getPdfDocument({
      data,
      disableFontFace: true,
      isEvalSupported: false,
      useSystemFonts: true,
    }).promise;
    try {
      return await extractMeetingPdfText(document);
    } finally {
      await document.destroy();
    }
  },
});
