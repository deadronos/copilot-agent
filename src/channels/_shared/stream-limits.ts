/**
 * Truncate text to maxLength, keeping the tail and prepending "…".
 * Used for live-stream sinks that show the most recent content.
 */
export function truncateToLength(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const prefix = '\u2026'; // …
  if (maxLength <= prefix.length) return prefix.slice(0, maxLength);
  return prefix + text.slice(-(maxLength - prefix.length));
}

/**
 * Split a long message into chunks that each fit within maxLength.
 * Splits on sentence boundaries (". ") then paragraph boundaries ("\n\n"),
 * falling back to word boundaries (" ") and finally hard character split.
 */
export function splitLongMessage(
  text: string,
  maxLength: number,
): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split on sentence boundary within maxLength
    const candidate = remaining.slice(0, maxLength + 1);
    const splitPoint = findSplitPoint(candidate, maxLength);
    chunks.push(remaining.slice(0, splitPoint).trimEnd());
    remaining = remaining.slice(splitPoint).trimStart();
  }

  return chunks;
}

function findSplitPoint(candidate: string, maxLength: number): number {
  // Prefer sentence boundary: ". " or ".\n"
  const sentenceMatch = lastIndexOf(candidate, /\.(?:\s|$)/, maxLength);
  if (sentenceMatch > 0) return sentenceMatch + 1;

  // Then paragraph boundary
  const paraMatch = candidate.lastIndexOf('\n\n', maxLength);
  if (paraMatch > 0) return paraMatch + 2;

  // Then word boundary
  const spaceIdx = candidate.lastIndexOf(' ', maxLength);
  if (spaceIdx > 0) return spaceIdx;

  // Fallback: hard split
  return maxLength;
}

function lastIndexOf(
  text: string,
  pattern: RegExp,
  maxIndex: number,
): number {
  const substr = text.slice(0, maxIndex + 1);
  let last = -1;
  const regex = new RegExp(pattern.source, 'g' + pattern.flags);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(substr)) !== null) {
    last = match.index;
  }
  return last;
}
