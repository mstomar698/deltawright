// Post-settle input-integrity classifier (v0.9 Move 1). ONE pure function shared by the live arm
// (actAndObserve reads the committed value after settle) and the offline arm (diagnose-trace reads
// a fill/type action's params.value vs the after frame-snapshot), so both name the same shape and
// can't drift. No I/O, no Playwright — a plain string comparison over (intended, committed).
//
// It answers "what happened to the value?" not "did the action fail?": Playwright's fill/type
// reported success (DW-02 untouched); this only compares the intent to what the field committed
// AFTER the settle window, catching the async debounce-then-clear a synchronous post-fill check
// cannot see. Language- and obfuscation-independent by construction — it reads no role/name/text.

import type { InputShape } from './types';

// A "content" code point — a Unicode letter or number. Dropping one is real character loss; dropping
// ONLY separators/whitespace/punctuation is a subtractive formatting mask (a card field stripping
// spaces, a phone field stripping dashes, a trailing/leading trim), which is an INTENDED reformat,
// not keystroke loss. Unicode-aware (`\p{L}\p{N}`) so a dropped non-English letter (Cyrillic / CJK /
// diacritic) still counts as content on the legacy non-English target — a plain [A-Za-z0-9] check
// would wrongly treat those as separators and hide a real loss.
const CONTENT = /[\p{L}\p{N}]/u;

/**
 * Classify the committed value against the intended value (v0.9 Move 1). A LOSS shape fires ONLY
 * when the committed value is a subsequence of intent, is shorter, AND at least one DROPPED code
 * point is content (a letter or number — real characters were lost):
 *  - `never-committed` — committed is empty (an async widget cleared it).
 *  - `truncated`       — committed is a proper PREFIX of intent (a length-limited field).
 *  - `dropped`         — committed is a non-prefix subsequence of intent (dropped keystrokes).
 *
 * Everything else is `transformed` and is deliberately NOT flagged (DW-03 "unsure beats confidently
 * wrong"), because an intended reformat is indistinguishable from corruption:
 *  - a case/reorder/insertion mask (`acetaminophen` → `ACETAMINOPHEN`) — not a subsequence at all;
 *  - a value longer than / not a subsequence of intent;
 *  - crucially, a purely SUBTRACTIVE separator/whitespace mask (`4111 1111` → `41111111`, `hello ` →
 *    `hello`, `123-456` → `123456`) — which IS a shorter subsequence, but only formatting characters
 *    were removed, so it must not be mistaken for character loss.
 */
export function classifyInput(intended: string, committed: string): InputShape {
  if (committed === intended) return 'clean';
  // Walk intended, matching committed as a subsequence by CODE POINT (surrogate-pair safe), and note
  // whether any UNMATCHED intended code point is real content (a letter or number).
  const c = Array.from(committed);
  const t = Array.from(intended);
  let i = 0;
  let contentDropped = false;
  for (const ch of t) {
    if (i < c.length && ch === c[i]) {
      i++;
    } else if (CONTENT.test(ch)) {
      contentDropped = true;
    }
  }
  const isSubsequence = i === c.length; // every committed code point matched, in order
  if (isSubsequence && c.length < t.length && contentDropped) {
    if (c.length === 0) return 'never-committed';
    return intended.startsWith(committed) ? 'truncated' : 'dropped';
  }
  // Not a shorter subsequence, or only separators/whitespace were removed → an intended reformat/mask.
  return 'transformed';
}

/** The shapes that ground `input-not-committed` — a real, characters-were-lost drift (not a mask). */
export const LOSS_SHAPES: ReadonlySet<InputShape> = new Set<InputShape>([
  'never-committed',
  'truncated',
  'dropped',
]);
