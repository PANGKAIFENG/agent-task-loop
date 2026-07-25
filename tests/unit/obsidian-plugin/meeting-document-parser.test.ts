import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';

import {
  assertMeetingDocumentSize,
  createMeetingDocumentParser,
  MAX_MEETING_ATTACHMENT_BYTES,
  MAX_MEETING_DOCUMENT_CHARACTERS,
  MAX_MEETING_PDF_PAGES,
  MAX_MEETING_PDF_TEXT_ITEMS,
  meetingDocumentKind,
  parseMeetingDocument,
} from '../../../src/obsidian-plugin/meeting-document-parser.js';

const encoder = new TextEncoder();

async function syntheticDocx(text: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    '</Types>',
  ].join(''));
  zip.file('_rels/.rels', [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
    '</Relationships>',
  ].join(''));
  zip.file('word/document.xml', [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>`,
    '</w:document>',
  ].join(''));
  return zip.generateAsync({ type: 'uint8array' });
}

function syntheticPdf(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n`;
  body += '0000000000 65535 f \n';
  body += offsets.slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  body += [
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    'startxref',
    String(xref),
    '%%EOF',
    '',
  ].join('\n');
  return encoder.encode(body);
}

function forgeZipUncompressedSizes(data: Uint8Array, declaredSize: number): Uint8Array {
  const forged = data.slice();
  const view = new DataView(forged.buffer, forged.byteOffset, forged.byteLength);
  for (let offset = 0; offset <= forged.byteLength - 28; offset += 1) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x04034b50) view.setUint32(offset + 22, declaredSize, true);
    if (signature === 0x02014b50) view.setUint32(offset + 24, declaredSize, true);
  }
  return forged;
}

function pdfTextStream(
  chunks: Array<{ items: unknown[] }>,
  onCancel: () => void = () => undefined,
): ReadableStream<{ items: unknown[] }> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
    },
    cancel: onCancel,
  }, { highWaterMark: 0 });
}

describe('meeting document parser', () => {
  it.each([
    ['notes.TXT', 'txt'],
    ['notes.md', 'md'],
    ['interview.DocX', 'docx'],
    ['brief.PDF', 'pdf'],
    ['recording.mp3', null],
    ['no-extension', null],
  ])('classifies %s as %s', (name, expected) => {
    expect(meetingDocumentKind(name)).toBe(expected);
  });

  it('decodes UTF-8 text, removes a BOM and preserves meaningful whitespace', async () => {
    const parse = createMeetingDocumentParser({
      extractDocx: vi.fn(),
      extractPdf: vi.fn(),
    });

    await expect(parse({
      name: 'meeting.txt',
      data: encoder.encode('\uFEFF第一行\n\n第二行\n'),
    })).resolves.toBe('第一行\n\n第二行\n');
  });

  it('routes DOCX and PDF bytes through the bounded document extractors', async () => {
    const extractDocx = vi.fn(async () => 'DOCX 听记');
    const extractPdf = vi.fn(async () => 'PDF 资料');
    const parse = createMeetingDocumentParser({ extractDocx, extractPdf });
    const bytes = new Uint8Array([1, 2, 3]);

    await expect(parse({ name: 'meeting.docx', data: bytes }))
      .resolves.toBe('DOCX 听记');
    await expect(parse({ name: 'context.pdf', data: bytes }))
      .resolves.toBe('PDF 资料');
    expect(extractDocx).toHaveBeenCalledOnce();
    expect(extractPdf).toHaveBeenCalledOnce();
  });

  it('rejects unsupported, invalid UTF-8, blank and oversized documents', async () => {
    const parse = createMeetingDocumentParser({
      extractDocx: vi.fn(),
      extractPdf: vi.fn(),
    });

    await expect(parse({ name: 'voice.mp3', data: new Uint8Array([1]) }))
      .rejects.toThrow('暂不支持解析');
    await expect(parse({ name: 'broken.txt', data: new Uint8Array([0xff]) }))
      .rejects.toThrow('UTF-8');
    await expect(parse({ name: 'blank.md', data: encoder.encode(' \n\t') }))
      .rejects.toThrow('没有可分析文本');
    expect(() => assertMeetingDocumentSize(MAX_MEETING_ATTACHMENT_BYTES + 1))
      .toThrow('50 MiB');
  });

  it('rejects extracted document text above the analysis character budget', async () => {
    const oversized = 'x'.repeat(MAX_MEETING_DOCUMENT_CHARACTERS + 1);
    const parse = createMeetingDocumentParser({
      extractDocx: vi.fn(async () => oversized),
      extractPdf: vi.fn(async () => oversized),
    });

    await expect(parse({ name: 'large.docx', data: new Uint8Array([1]) }))
      .rejects.toThrow('100,000');
    await expect(parse({ name: 'large.pdf', data: new Uint8Array([1]) }))
      .rejects.toThrow('100,000');
  });

  it('reads PDF pages sequentially and stops as soon as the character budget is exceeded', async () => {
    const module = await import('../../../src/obsidian-plugin/meeting-document-parser.js');
    const extractMeetingPdfText = (module as unknown as {
      extractMeetingPdfText(document: unknown): Promise<string>;
    }).extractMeetingPdfText;
    const getPage = vi.fn(async (pageNumber: number) => ({
      streamTextContent: () => pdfTextStream([{ items: [{
          str: pageNumber <= 2
            ? 'x'.repeat((MAX_MEETING_DOCUMENT_CHARACTERS / 2) + 1)
            : 'must not be read',
          hasEOL: false,
        }] }]),
    }));

    await expect(extractMeetingPdfText({ numPages: 3, getPage }))
      .rejects.toThrow('100,000');
    expect(getPage).toHaveBeenCalledTimes(2);
    expect(getPage).not.toHaveBeenCalledWith(3);
  });

  it('rejects a PDF whose page count exceeds the parsing work budget', async () => {
    const module = await import('../../../src/obsidian-plugin/meeting-document-parser.js');
    const extractMeetingPdfText = (module as unknown as {
      extractMeetingPdfText(document: unknown): Promise<string>;
    }).extractMeetingPdfText;
    const getPage = vi.fn();

    await expect(extractMeetingPdfText({
      numPages: MAX_MEETING_PDF_PAGES + 1,
      getPage,
    })).rejects.toThrow(String(MAX_MEETING_PDF_PAGES));
    expect(getPage).not.toHaveBeenCalled();
  });

  it('rejects a PDF page whose text item count exceeds the parsing work budget', async () => {
    const module = await import('../../../src/obsidian-plugin/meeting-document-parser.js');
    const extractMeetingPdfText = (module as unknown as {
      extractMeetingPdfText(document: unknown): Promise<string>;
    }).extractMeetingPdfText;
    const items = Array.from({ length: MAX_MEETING_PDF_TEXT_ITEMS + 1 }, () => ({
      str: '',
      hasEOL: false,
    }));

    await expect(extractMeetingPdfText({
      numPages: 1,
      getPage: vi.fn(async () => ({
        streamTextContent: () => pdfTextStream([{ items }]),
      })),
    })).rejects.toThrow(MAX_MEETING_PDF_TEXT_ITEMS.toLocaleString('en-US'));
  });

  it('cancels streamed PDF text before reading chunks beyond the work budget', async () => {
    const module = await import('../../../src/obsidian-plugin/meeting-document-parser.js');
    const extractMeetingPdfText = (module as unknown as {
      extractMeetingPdfText(
        document: unknown,
        limits: { maximumTextItems: number },
      ): Promise<string>;
    }).extractMeetingPdfText;
    const cancelled = vi.fn();
    const getTextContent = vi.fn(async () => {
      throw new Error('must not materialize a complete PDF page');
    });
    const stream = pdfTextStream([
      { items: [{ str: '第一项', hasEOL: false }] },
      { items: [{ str: '第二项', hasEOL: false }] },
      { items: [{ str: 'must not be read', hasEOL: false }] },
    ], cancelled);

    await expect(extractMeetingPdfText({
      numPages: 1,
      getPage: vi.fn(async () => ({ getTextContent, streamTextContent: () => stream })),
    }, { maximumTextItems: 1 })).rejects.toThrow('1');
    expect(cancelled).toHaveBeenCalledOnce();
    expect(getTextContent).not.toHaveBeenCalled();
  });

  it('rejects a highly expanded DOCX archive before invoking mammoth', async () => {
    const module = await import('../../../src/obsidian-plugin/meeting-document-parser.js');
    const createMeetingDocxExtractor = (module as unknown as {
      createMeetingDocxExtractor(dependencies: {
        expandedSize(data: Uint8Array): Promise<number>;
        extractRawText(data: Uint8Array): Promise<string>;
      }): (data: Uint8Array) => Promise<string>;
    }).createMeetingDocxExtractor;
    const extractRawText = vi.fn(async () => 'must not run');
    const extract = createMeetingDocxExtractor({
      expandedSize: vi.fn(async () => (64 * 1024 * 1024) + 1),
      extractRawText,
    });

    await expect(extract(new Uint8Array([1, 2, 3])))
      .rejects.toThrow('64 MiB');
    expect(extractRawText).not.toHaveBeenCalled();
  });

  it('measures actual DOCX output instead of trusting forged ZIP size declarations', async () => {
    const module = await import('../../../src/obsidian-plugin/meeting-document-parser.js');
    const docxExpandedSize = (module as unknown as {
      docxExpandedSize(data: Uint8Array, maximumBytes: number): Promise<number>;
    }).docxExpandedSize;
    const zip = new JSZip();
    zip.file('word/document.xml', 'x'.repeat(4_096));
    const compressed = await zip.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
    });

    await expect(docxExpandedSize(forgeZipUncompressedSizes(compressed, 1), 1_024))
      .rejects.toThrow('1,024');
  });

  it('extracts text from an actual synthetic DOCX with the production parser', async () => {
    await expect(parseMeetingDocument({
      name: 'synthetic.docx',
      data: await syntheticDocx('Synthetic DOCX meeting notes'),
    })).resolves.toContain('Synthetic DOCX meeting notes');
  });

  it('extracts text from an actual synthetic PDF with the production parser', async () => {
    await expect(parseMeetingDocument({
      name: 'synthetic.pdf',
      data: syntheticPdf('Synthetic PDF meeting notes'),
    })).resolves.toContain('Synthetic PDF meeting notes');
  });
});
