import { PDFDocument } from "pdf-lib";

/**
 * Extrai cada pagina do PDF como documento de 1 pagina, em base64 (para envio ao Gemini).
 */
export async function splitPdfToSinglePageBase64(pdfBytes: Buffer): Promise<string[]> {
  const src = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const count = src.getPageCount();
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const doc = await PDFDocument.create();
    const [page] = await doc.copyPages(src, [i]);
    doc.addPage(page);
    const bytes = await doc.save();
    out.push(Buffer.from(bytes).toString("base64"));
  }
  return out;
}
