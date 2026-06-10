# PASTE-008 — Content verification to chase byte-perfect (100%)

**Date:** 2026-06-10
**Status:** Feasibility established (decisive) — scope recommendation below

## Goal

Close the last gap to byte-perfect. Count-based verify (PASTE-006) catches
every LENGTH-changing error (drops/inserts) but is blind to **same-length
substitutions** — the rare Shift/case race (`Quick`→`quick`) seen in the
100k run. Catching those needs reading the actual CONTENT back. The only
in-product channel is the KVM video → OCR (no network/sharing allowed).

## Feasibility spike (the gating question: is text OCR accurate enough?)

OCR'd known-content Notepad screenshots and compared to truth:

- **Plaintext / prose:** EXACT, including case — `L1797 the Quick brown Fox
  jumps over 13 lazy Dogs. ;` read perfectly (capital Q/F/D correct). So a
  same-length case substitution WOULD be detectable on prose.
- **Code / symbol-heavy:** too noisy to trust — observed OCR errors
  `arr[0]`→`arr[@]`, `^ c`→`* c`, `(a%b)`→`(a%h)`, straight quotes→curly,
  `L0007`→`Le007`. Indistinguishable from real substitution errors → would
  false-positive constantly.

## Conclusion — what 100% is actually achievable

| Content | Drops/inserts | Same-length substitutions | Byte-perfect achievable? |
|---|---|---|---|
| Prose / plain text | ✓ count-verify | ✓ content-OCR (reliable) | **Yes** (content-OCR verify + repair) |
| Code / symbols | ✓ count-verify | ✗ OCR too noisy on symbols | **No** via video-only; best = count-verified + layout-correct + resume; residual ≈ 1 same-length race / ~100k, unverifiable |

**Fundamental limit:** for CODE (the primary use case) the symbols are both
where host races/layout issues occur AND where OCR is unreliable — so a
*guaranteed* 100% byte-perfect for code is not reachable through the paste-
tool/video channel alone. Network sharing would solve it instantly but is
out of scope by constraint.

## Recommended scope (pick)

1. **Prose content-verify mode** — for plain-text pastes, OCR each chunk's
   text and diff vs source (reliable per spike); repair on mismatch. Gives
   true byte-perfect for prose. (Doesn't help code.)
2. **PASTE-009 source-side reduction** — the only lever for code's residual:
   hold the modifier+key longer so the host reliably samples Shift with the
   key, reducing case-races at the source (can't be verified, only reduced).
3. **Accept + set expectations** — count-verify + layout-correct + resume is
   the honest ceiling for code; surface "character count + structure
   verified; spot-check symbol-heavy lines" in the completion summary.

The count-verify + slow-retype repair (PASTE-006) already delivers
byte-perfect for all length errors; the above is purely about the rare
same-length substitution on code.
