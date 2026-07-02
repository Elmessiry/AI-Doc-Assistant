// Splits extracted document text into overlapping windows for later
// embedding + retrieval. Sizes are in CHARACTERS; ~4 chars ≈ 1 token for
// English, so 2000/200 is roughly a 500-token chunk with 50-token overlap.

const DEFAULT_SIZE = 2000;
const DEFAULT_OVERLAP = 200;

export function chunkText(
  text: string,
  size = DEFAULT_SIZE,
  overlap = DEFAULT_OVERLAP,
): string[] {
  if (overlap >= size) {
    // step would be <= 0 and the loop below would never advance.
    throw new Error("chunk overlap must be smaller than chunk size");
  }

  // Collapse runs of whitespace/newlines from PDF extraction into single
  // spaces so chunk boundaries fall on real word gaps, not stray "\n\n".
  const clean = text.replace(/\s+/g, " ").trim();

  if (clean.length === 0) return [];
  if (clean.length <= size) return [clean];

  const step = size - overlap; // how far the window slides each iteration
  const chunks: string[] = [];

  for (let start = 0; start < clean.length; start += step) {
    chunks.push(clean.slice(start, start + size));
    // Once this window reaches the end, stop — otherwise the overlap would
    // emit extra tail-only chunks that repeat text already captured.
    if (start + size >= clean.length) break;
  }

  return chunks;
}
