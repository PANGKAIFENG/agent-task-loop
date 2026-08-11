import mammoth from 'mammoth';
import { Buffer } from 'node:buffer';
import type { Readable } from 'node:stream';
import { parse as parseCsv } from 'csv-parse/sync';
import JSZip from 'jszip';
import readXlsxFile from 'read-excel-file/node';
import * as PDFJS from 'unpdf/pdfjs';

export const MAX_MEETING_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const MAX_MEETING_DOCUMENT_CHARACTERS = 100_000;
export const MAX_MEETING_DOCX_EXPANDED_BYTES = 64 * 1024 * 1024;
export const MAX_MEETING_XLSX_EXPANDED_BYTES = 128 * 1024 * 1024;
export const MAX_MEETING_PDF_PAGES = 500;
export const MAX_MEETING_PDF_TEXT_ITEMS = 100_000;
export const MAX_MEETING_SPREADSHEET_ROWS = 10_000;
export const MAX_MEETING_SPREADSHEET_COLUMNS = 256;
export const MAX_MEETING_SPREADSHEET_SHEETS = 20;

export type MeetingDocumentKind = 'txt' | 'md' | 'docx' | 'pdf' | 'csv' | 'xlsx';

export interface MeetingDocumentInput {
  name: string;
  data: Uint8Array;
}

export interface MeetingDocumentParserDependencies {
  extractDocx(data: Uint8Array): Promise<string>;
  extractPdf(data: Uint8Array): Promise<string>;
  extractXlsx?(data: Uint8Array): Promise<string>;
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

class MeetingDocumentLimitError extends Error {}

function documentTooLongError(
  maximumCharacters = MAX_MEETING_DOCUMENT_CHARACTERS,
): MeetingDocumentLimitError {
  return new MeetingDocumentLimitError(
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

function expandedTooLargeError(
  maximumBytes: number,
  documentKind: 'DOCX' | 'XLSX',
): Error {
  const label = documentKind === 'DOCX' && maximumBytes === MAX_MEETING_DOCX_EXPANDED_BYTES
    ? '64 MiB'
    : documentKind === 'XLSX' && maximumBytes === MAX_MEETING_XLSX_EXPANDED_BYTES
      ? '128 MiB'
      : `${maximumBytes.toLocaleString('en-US')} bytes`;
  return new Error(`${documentKind} 解压后内容不能超过 ${label}`);
}

export async function docxExpandedSize(
  data: Uint8Array,
  maximumBytes = MAX_MEETING_DOCX_EXPANDED_BYTES,
  documentKind: 'DOCX' | 'XLSX' = 'DOCX',
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
          reject(new Error(`${documentKind} 解压后大小无效`));
          return;
        }
        if (total > maximumBytes) {
          settled = true;
          stream.destroy();
          reject(expandedTooLargeError(maximumBytes, documentKind));
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
      throw expandedTooLargeError(MAX_MEETING_DOCX_EXPANDED_BYTES, 'DOCX');
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
    || extension === 'csv'
    || extension === 'xlsx'
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

function normalizedSpreadsheetCell(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function spreadsheetCellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

class MeetingSpreadsheetLimitError extends Error {}

function spreadsheetRowsExceededError(): MeetingSpreadsheetLimitError {
  return new MeetingSpreadsheetLimitError(
    `表格不能超过 ${MAX_MEETING_SPREADSHEET_ROWS.toLocaleString('en-US')} 行`,
  );
}

function spreadsheetColumnsExceededError(): MeetingSpreadsheetLimitError {
  return new MeetingSpreadsheetLimitError(
    `表格不能超过 ${MAX_MEETING_SPREADSHEET_COLUMNS} 列`,
  );
}

function spreadsheetRowsText(rows: readonly (readonly string[])[]): string {
  if (rows.length > MAX_MEETING_SPREADSHEET_ROWS) {
    throw spreadsheetRowsExceededError();
  }
  const lines: string[] = [];
  let characters = 0;
  for (const row of rows) {
    if (row.length > MAX_MEETING_SPREADSHEET_COLUMNS) {
      throw spreadsheetColumnsExceededError();
    }
    const line = row.map(normalizedSpreadsheetCell).join('\t').replace(/\t+$/u, '');
    if (line === '') continue;
    characters += line.length + (lines.length === 0 ? 0 : 1);
    if (characters > MAX_MEETING_DOCUMENT_CHARACTERS) throw documentTooLongError();
    lines.push(line);
  }
  return lines.join('\n');
}

export function parseMeetingCsvText(value: string): string {
  let rows: string[][];
  let rowCount = 0;
  let characters = 0;
  try {
    rows = parseCsv(value, {
      bom: true,
      relax_column_count: true,
      skip_empty_lines: true,
      max_record_size: MAX_MEETING_DOCUMENT_CHARACTERS,
      on_record: (record: string[]) => {
        rowCount += 1;
        if (rowCount > MAX_MEETING_SPREADSHEET_ROWS) {
          throw spreadsheetRowsExceededError();
        }
        if (record.length > MAX_MEETING_SPREADSHEET_COLUMNS) {
          throw spreadsheetColumnsExceededError();
        }
        const line = record.map(normalizedSpreadsheetCell).join('\t').replace(/\t+$/u, '');
        if (line !== '') {
          characters += line.length + (characters === 0 ? 0 : 1);
          if (characters > MAX_MEETING_DOCUMENT_CHARACTERS) throw documentTooLongError();
        }
        return record;
      },
    }) as string[][];
  } catch (error) {
    if (
      error instanceof MeetingSpreadsheetLimitError
      || error instanceof MeetingDocumentLimitError
    ) throw error;
    throw new Error('CSV 文件结构无效');
  }
  return spreadsheetRowsText(rows);
}

export async function extractMeetingXlsxText(data: Uint8Array): Promise<string> {
  await docxExpandedSize(data, MAX_MEETING_XLSX_EXPANDED_BYTES, 'XLSX');
  const sheets = await readXlsxFile(Buffer.from(data));
  if (sheets.length > MAX_MEETING_SPREADSHEET_SHEETS) {
    throw new Error(`XLSX 不能超过 ${MAX_MEETING_SPREADSHEET_SHEETS} 个工作表`);
  }
  const rows: string[][] = [];
  for (const sheet of sheets) {
    if (sheet.data.length > MAX_MEETING_SPREADSHEET_ROWS - rows.length) {
      throw new Error(`表格不能超过 ${MAX_MEETING_SPREADSHEET_ROWS.toLocaleString('en-US')} 行`);
    }
    if (sheet.data.some((row) => row.length > MAX_MEETING_SPREADSHEET_COLUMNS)) {
      throw new Error(`表格不能超过 ${MAX_MEETING_SPREADSHEET_COLUMNS} 列`);
    }
    if (sheets.length > 1) rows.push([`工作表：${sheet.sheet}`]);
    rows.push(...sheet.data.map((row) => row.map(spreadsheetCellText)));
  }
  return spreadsheetRowsText(rows);
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

    if (kind === 'txt' || kind === 'md' || kind === 'csv') {
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(input.data);
      } catch {
        throw new Error('文本文件必须使用 UTF-8 编码');
      }
      return validatedText(kind === 'csv' ? parseMeetingCsvText(text) : text);
    }

    let text: string;
    if (kind === 'docx') text = await dependencies.extractDocx(input.data);
    else if (kind === 'pdf') text = await dependencies.extractPdf(input.data);
    else if (dependencies.extractXlsx !== undefined) {
      text = await dependencies.extractXlsx(input.data);
    } else {
      throw new Error('暂不支持解析此文件格式');
    }
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
  extractXlsx: extractMeetingXlsxText,
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
