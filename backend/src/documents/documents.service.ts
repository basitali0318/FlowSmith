import { BadRequestException, Injectable } from '@nestjs/common';

export const MAX_TEXT_CHARS = 15000;

@Injectable()
export class DocumentsService {
  /** Extract plain text from an uploaded SOP (.txt, .md, .docx, .pdf). */
  async extractText(file: { originalname: string; buffer: Buffer; mimetype?: string }): Promise<string> {
    const name = file.originalname.toLowerCase();
    let text: string;
    try {
      if (name.endsWith('.docx')) {
        const mammoth = await import('mammoth');
        text = (await mammoth.extractRawText({ buffer: file.buffer })).value;
      } else if (name.endsWith('.pdf')) {
        const pdf = (await import('pdf-parse/lib/pdf-parse.js')).default;
        text = (await pdf(file.buffer)).text;
      } else if (/\.(txt|md|markdown|csv|text)$/.test(name) || file.mimetype?.startsWith('text/')) {
        text = file.buffer.toString('utf8');
      } else {
        throw new BadRequestException('Unsupported file type. Upload a .txt, .md, .docx or .pdf file.');
      }
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException(`Could not read "${file.originalname}": the file looks corrupted or is not a valid document.`);
    }
    text = text.replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) throw new BadRequestException('The uploaded file contains no readable text (scanned PDFs are not supported).');
    return text.slice(0, MAX_TEXT_CHARS);
  }
}
