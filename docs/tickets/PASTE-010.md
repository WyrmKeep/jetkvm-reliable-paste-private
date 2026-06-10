# PASTE-010 — Special-symbol corruption is a keyboard-LAYOUT mismatch (not paste loss)

**Date:** 2026-06-10
**Status:** Root-caused & fixed (config) — see recommendation

## Benchmark

User-requested realistic test: a ~20k code file packed with the special
symbols that historically broke (`@ " # ~ \ | { } [ ] ( ) % ^ & $ \``…),
pasted via the real UI (file upload, Reliable), read back byte-exact over
SSH and line-diffed.

## Result — systematic, not random

With JetKVM set to **en-UK**: 227 of 275 lines damaged (82%). The pattern
was deterministic, confirmed by character counts:

| char | sent | received (en-UK) |
|------|------|------------------|
| `@`  | 104  | 603 |
| `"`  | 612  | 103 |

**`@` and `"` are swapped** — the textbook US↔UK difference (UK: `@`=Shift+',
`"`=Shift+2; US: reversed). I.e. the target interprets JetKVM's scancodes
under a **US** layout, but JetKVM was sending **UK**.

With JetKVM switched to **en-US**: counts match (`@` 30→29, `"` 60→58,
`#` 10→9 — only tiny host-race drops), no swap, symbols visually + byte
correct. So:

**Root cause of "special symbols break" = keyboard-layout mismatch, entirely
separate from the paste-reliability work.** The fix is to set JetKVM's
keyboard layout to match what the target actually decodes — here **en-US**
(the target reads input as US even though its display locale is en-GB; common
on dev machines). Changed `keyboard_layout` to `en-US` in the device config.

## Residual after the fix

Sparse single-char host races remain (~0.1–0.3%, elevated when the host is
busy): a dropped quote, `1`→`!`, `#`→`3` (Shift races). Same floor as the
plain-text 100k result — addressed by auto-verify + resume, not by layout.

## Recommendations

1. **Set the JetKVM keyboard layout to match the target's active layout.**
   Mismatch silently corrupts every shifted symbol. This is the #1 cause of
   "paste types the wrong characters" and should be surfaced in the paste UI
   (e.g. a layout reminder/selector near the paste action).
2. **Audit `ui/src/keyboardLayouts/en_UK.ts`** — if the target had been truly
   UK and en-UK still swapped @/", the layout file itself is wrong. (Here the
   target was effectively US, so en-US is correct; worth confirming en-UK maps
   @=Shift+Quote, "=Shift+Digit2 correctly regardless.)
3. Possible UX: detect/declare the target layout, or include a one-line
   "verify these symbols look right" check before a big code paste.
