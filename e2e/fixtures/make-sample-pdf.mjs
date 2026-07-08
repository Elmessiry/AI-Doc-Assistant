// Generates a tiny, valid single-page PDF with a known sentinel string, used
// as the upload fixture in the E2E test. Kept as a script (rather than only
// committing the binary) so the fixture is reproducible and reviewable.
//
// Run: node e2e/fixtures/make-sample-pdf.mjs
//
// The sentinel (SENTINEL below) must match the value the spec asserts on.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SENTINEL = "ZEBRA-42931";
// Long enough that the extracted text clears the processing route's
// MIN_TEXT_LENGTH (100 chars) gate, so the document reaches "Searchable"
// instead of being treated as a scanned/image-only PDF. The sentinel sits
// mid-paragraph so it survives any edge-glyph trimming by the PDF parser.
const text =
  `This is a sample document used by the automated end-to-end test. ` +
  `The sentinel code ${SENTINEL} is the passphrase recorded in this file. ` +
  `It exists so the test can verify that uploaded text is extracted, ` +
  `chunked, retrieved, and answered correctly by the chat pipeline.`;

// Build the PDF as a list of objects, tracking each object's byte offset so
// the cross-reference (xref) table is correct — pdf parsers rely on it.
const header = "%PDF-1.4\n";
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
    "/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
  (() => {
    // Wrap into ~60-char lines, each absolutely positioned with Tm. A single
    // long line would overflow the page width and the parser drops off-page
    // glyphs during text extraction, silently truncating the content.
    const words = text.split(" ");
    const lines = [];
    let line = "";
    for (const word of words) {
      if ((line + " " + word).trim().length > 60) {
        lines.push(line.trim());
        line = word;
      } else {
        line = `${line} ${word}`;
      }
    }
    if (line.trim()) lines.push(line.trim());

    const body = lines
      .map((ln, i) => `1 0 0 1 72 ${720 - i * 22} Tm (${ln}) Tj`)
      .join("\n");
    const stream = `BT /F1 14 Tf\n${body}\nET`;
    return `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  })(),
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
];

let body = "";
const offsets = [];
objects.forEach((obj, i) => {
  offsets.push(header.length + body.length);
  body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
});

const xrefStart = header.length + body.length;
let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const off of offsets) {
  xref += `${String(off).padStart(10, "0")} 00000 n \n`;
}

const trailer =
  `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
  `startxref\n${xrefStart}\n%%EOF\n`;

const pdf = header + body + xref + trailer;

const out = join(dirname(fileURLToPath(import.meta.url)), "sample.pdf");
writeFileSync(out, pdf, "latin1");
console.log(`Wrote ${out} (${pdf.length} bytes), sentinel: ${SENTINEL}`);
