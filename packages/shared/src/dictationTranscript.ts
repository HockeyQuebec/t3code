/**
 * Reconciling live dictation segments into one transcript.
 *
 * Consecutive segments deliberately share a second of audio so a word spoken
 * across the cut is heard whole by at least one of them. That repeat has to
 * come back out of the text, and the seam is not a clean string match: the
 * earlier segment often ends on a clipped word ("a transcrip") that the later
 * one heard properly ("a transcription test").
 */

interface TranscriptWord {
  readonly word: string;
  readonly start: number;
}

/** Words plus their character locations, used to reconcile repeated audio. */
export function transcriptWords(text: string): ReadonlyArray<TranscriptWord> {
  return [...String(text ?? "").matchAll(/[\p{L}\p{N}'’]+/gu)].map((match) => ({
    word: match[0].toLocaleLowerCase(),
    start: match.index,
  }));
}

/** How far back into the previous transcript a seam is worth looking for. */
const MAX_OVERLAP_WORDS = 12;

/**
 * Merge a transcript whose opening words repeat the prior transcript's tail.
 *
 * A prefix match is intentional: it turns a boundary result such as
 * "a transcrip" + "a transcription test" into "a transcription test", rather
 * than preserving the clipped word or printing the repeated audio twice. When
 * no seam is found the two are simply joined — a wrong guess would silently
 * eat words, and a duplicated phrase is the cheaper mistake to correct.
 */
export function mergeTranscript(previous: string, current: string): string {
  const left = String(previous ?? "").trim();
  const right = String(current ?? "").trim();
  if (left.length === 0) return right;
  if (right.length === 0) return left;

  const before = transcriptWords(left);
  const after = transcriptWords(right);
  let best: { index: number; count: number; score: number } | null = null;
  const first = Math.max(0, before.length - MAX_OVERLAP_WORDS);

  for (let i = first; i < before.length; i++) {
    const count = before.length - i;
    if (count > after.length) continue;
    let score = 0;
    let compatible = true;
    for (let j = 0; j < count; j++) {
      const a = before[i + j]!.word;
      const b = after[j]!.word;
      if (a === b) {
        // An exact word is worth more than a truncation, so a seam that lines
        // up wholly beats one that only nearly does at the same length.
        score += 2;
      } else if (Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a))) {
        score += 1;
      } else {
        compatible = false;
        break;
      }
    }
    if (
      compatible &&
      (best === null || count > best.count || (count === best.count && score > best.score))
    ) {
      best = { index: i, count, score };
    }
  }

  if (best === null) return `${left} ${right}`;
  const prefix = left.slice(0, before[best.index]!.start).trimEnd();
  return prefix.length > 0 ? `${prefix} ${right}` : right;
}

/**
 * How the transcript joins whatever was already in the composer.
 *
 * Dictation appends rather than replaces, so it needs a space unless the text
 * already ends in whitespace — and no space at all when the box was empty.
 */
export function joinDictationPrefix(prefix: string, transcript: string): string {
  if (prefix.length === 0) return transcript;
  const separator = /\s$/.test(prefix) ? "" : " ";
  return `${prefix}${separator}${transcript}`;
}
