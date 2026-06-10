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

## PASTE-009 soak (2026-06-10)

Clean byte-exact code-paste (20,060 chars, en-US + modifier-hold, via UI,
harness completion fixed to key on the app's `done:` trace):
- Symbols correct, **no swaps** (@ 104→103, " 612→603, # 70→70, \ 238→238 —
  shortfalls are sparse drops, not layout).
- ~99.1% chars this run (−174) — host moderately churny; errors are sparse
  host-races (drops, an `=`→`+` shift-stuck). Same host-dependent variance as
  plaintext; **not a regression, not layout**.
- PASTE-009 confirmed **non-regressive**. Case-race reduction not directly
  measurable in one churn-dominated run (rare event), but low-risk + sound.
- Also fixed the test harness: completion now keys on the `done:` trace line,
  not the Confirm button (which flipped between chunks and caused an earlier
  partial-save artifact).

## Code consistency band — raw channel, calm host (2026-06-10)

Three byte-exact code runs (20,059 chars after norm, en-US, `code20k.txt`)
on a **calm host (0 CPU spikes >40% all three runs)**, typed via the
standalone `hidtype` test binary (2ms atomic modifier+key hold — this path
does **NOT** include PASTE-009's 10ms hold, so it's a clean *baseline* of the
underlying channel, not a PASTE-009 validation):

| Run | Chars lost | Accuracy | Single-char drops | Same-length subs |
|---|---|---|---|---|
| cd1 | 8  | 99.96% | 8  | — (per-line detail lost to a stale diff regex; char count authoritative) |
| cd2 | 10 | 99.95% | 10 | 1 — `?? 0`→`/? 0` (Shift dropped on `/`) |
| cd3 | 14 | 99.93% | 14 | 2 — `=> v`→`+> v` (Shift stuck → `=`/`+`), `?? 0`→`/? 0` |

**Band: 99.93–99.96% raw, ~8–14 sparse drops per 20k.** Tight and
host-correlated (matches prose; not code-specific). Two error classes:

1. **Single-char drops (the bulk):** every one is **length-changing**, so the
   product's count-verify (PASTE-006) detects and the slow-retype repair fixes
   all of them. This is the "mechanism to catch it" — drops never survive
   silently end-to-end.
2. **Same-length Shift races (0–2 per 20k):** `??`→`/?`, `=`→`+`. Length
   unchanged → **count-verify is blind** (the documented code ceiling above).
   Seen even with atomic mod+key reports at 2ms hold; PASTE-009's 10ms hold
   targets exactly this and should reduce the rate (built, calm-host product
   soak still pending — these baseline runs bypass it).

**Bottom line for code:** drops are fully catchable (count-verify + repair);
the residual is ~0–2 unverifiable same-length Shift races per 20k chars
(≈1 per 10–20k), reduced but not eliminated by PASTE-009. Byte-exact harness
(`exact-diff.js`) is the only way to surface those — by design they can't be
caught through the video/OCR channel on symbol-heavy code.

- Fixed `exact-diff.js` line-key regex (`/^(L\d{4})/`→`/(L\d{4})/`): corpus
  lines start with `//L####`, so the anchored form matched nothing and flagged
  every line as "mangled" (the cd1 `damagedLines=275` artifact). Char-count
  delta was always authoritative; per-line detail is now correct too.

## 100k code at scale — document-size degradation (2026-06-10, decisive)

Ran the full 100k code corpus (`code100k.txt`, 103,891 chars, same template
cycle/symbol density as code20k, generated by `gen-code100k.js`) byte-exact,
raw `hidtype` at 91cps, on a calm host (0 CPU spikes >40% across 1130 samples).

**Result: received 103,060 / sent 103,891 = 99.20% raw** — ~10× worse per
char than the 20k runs (99.95%). The loss is **not linear with size**; it
*accelerates* as the target document grows:

| File third (lines) | Drops (caught by count) | Silent same-length subs |
|---|---|---|
| 1–467   | 39  | 5  |
| 468–935 | 105 | 22 |
| 936–1404| 325 | 24 |
| **total** | **401 + 24 line-merges + 68 mangled-prefix = 493 length-changing** | **51 silent** |

**Mechanism (proven, not inferred):** the device's *send* rate held at 90.98
cps the entire 19 min (deadline pacing immune to drift), and CPU was flat —
so the degradation is 100% **host-side and document-size-driven**: as Notepad's
single text buffer grows toward 100k chars, each keystroke insert costs more
(buffer re-layout/render), the USB-HID input queue backs up, and BOTH error
classes climb. Not CPU churn, not a send-side slowdown.

**Implications for "100k code at scale":**
1. The ~493 length-changing errors are all caught by count-verify; the
   product's chunked paste verifies+repairs per chunk, so net length loss
   end-to-end should be ~0 (repair load is heavy though).
2. The **51 silent same-length subs** (`?`/`/`, `)`/`0`, `}`/`]` Shift races)
   are the real residual and they ALSO scale with document size (~1 per 2k at
   100k vs ~1 per 15k at 20k). Count-verify is blind to them; OCR can't read
   code symbols. This is the hard ceiling, worse at scale.
3. **Notepad is a worst-case sink for large code** — a single plain-text buffer
   with O(n) insert cost. A real code editor (VS Code, Notepad++) with a rope/
   piece-table buffer likely degrades far less. Real code workflows paste into
   an IDE, not Notepad, so 99.2% is pessimistic for the actual use case.

**New lever this surfaces (PASTE-007 reframed):** a *fixed* pace is wrong for
large pastes into Notepad-class sinks — the right design eases the rate (or
lengthens chunk pauses) as the document grows, since the host's per-keystroke
cost is size-dependent. Chunk pauses already let the input queue drain between
chunks (the raw run has none), so the chunked product path should beat 99.2%
on drops; a 100k product-path soak (chunked + verify + repair, byte-diffed) is
the next validation.

## Catch mechanism PROVEN end-to-end on code (2026-06-10)

Product-path test (chunked + auto-verify OCR + auto-repair), byte-diffed, on
the **stable** device (after disabling auto-update — see below):

- **6k code, BYTE-PERFECT.** `ocr-calibrate: counter=0` (calibration succeeds —
  the Notepad counter IS readable), then auto-repair fired on all 5 chunks
  (each lost 5–13 chars at an elevated ~0.7%/chunk post-reboot rate), detected
  the deficit via the counter OCR, rolled back, re-typed, and converged:
  `sent=6021 recv=6021 delta=0, lines ok=84 damaged=0 missing=0`. **This is the
  detect→rollback→retype→byte-perfect loop working on code.**

**But OCR CALIBRATION IS FLAKY — the real reliability gap.** A clean 100k
product soak on the stable device (no reboot, 28min uptime, auto-update off)
STILL failed calibration: `ocr-calibrate: counter not found` after 3 retries →
0 verify events → unverified delivery at **97.58%** (sent 103891 / recv 101378).
Identical empty-Notepad starting state as the 6k run that succeeded — so this is
non-deterministic OCR flakiness in `findCounter` (whole-strip search), which the
PasteModal code itself flags as "flakier than the fixed-region read." It found
the counter at 6k, missed it at 100k. (The very first 100k soak ALSO had an
auto-reboot near the end — a second, now-removed confound — but the verify
failure is the calibration flakiness, not the reboot.)

**Net (corrected for real-user behaviour):** the detect→repair loop WORKS (6k
byte-perfect proves it), but it only engages AUTOMATICALLY when `findCounter`
locates the counter — a coin-flip at the calibration step. Crucially, calibration
failure does **NOT** silently paste unverified for a real user: `manualFallback`
sets `waitForChunkConfirm` (PasteModal ~L492-500) so the paste PAUSES at every
chunk and asks the user to glance at the target's own counter before continuing.
My `e2e-codeverify` harness auto-clicks "Continue" through those prompts (which
is why its byte-diff showed 97.58% "unverified") — a real user would be prompted
to verify each chunk. So the flakiness degrades the EXPERIENCE (full automation →
~70 manual chunk-confirms on a 100k paste), not the SAFETY (the user is always
given a verification path). Still the #1 thing to harden so large pastes stay
hands-off.

**Fix direction (PASTE-006 hardening):** the Notepad counter sits at a STABLE
screen position (bottom status strip). Calibration should seed the read region
from the video geometry (deterministic) instead of OCR-searching the whole strip
for the word "characters" each run — or, failing calibration, refuse to proceed
silently (force the manual "Verify each chunk" count-pause, which needs no OCR
locate). The robust always-on path today is manual "Verify each chunk" (human
reads the target's own counter at each pause).

## PASTE-013 outcome + the 100k auto-verify scalability wall (2026-06-10)

PASTE-013 shipped (calibrateCounter: cache the located region in localStorage +
bump findCounter SCALE 1.5→3 + 6 retries; PasteModal uses it). Result:
- **6k product run: BYTE-PERFECT, twice** — calibration engages (`counter=0`),
  auto-repair fixes all 5 chunks, delta=0. The region cache persists across
  pastes for a real user. PASTE-013 makes auto-verify reliable at small/medium
  size. CONFIRMED WIN.
- **100k product run: still not viable.** Three attempts now, each blocked a
  different way: (1) cloud auto-reboot mid-run; (2) calibration flake (pre-013);
  (3) post-013, the run stalled — Notepad showed only ~9 lines (<1 chunk) after
  ~60 min, process alive, no progress in the trace. Killed.

**The 100k wall (honest, with the open ambiguity):** a 100k auto-verify+repair
paste is impractical via this path. Per-chunk it does up to 8×700ms OCR
stabilization reads (≈5–11s) PLUS repair retypes, ×~70 chunks (auto-verify uses
1500-char chunks) — so even when working it's ~hour-scale, and over that long a
window the WebRTC/video link is fragile. The 3rd attempt's stall was EITHER a
chunk-1 delivery hang OR a KVM video-encoder freeze (which would make the ~9-line
screenshot a stale frame while the paste actually crept on) — couldn't
disambiguate remotely. A 20–30k verified run (watched to completion) would tell
us "slow-but-linear" vs "hangs"; not yet done.

**Net for the goal:** auto-verify+repair = hands-off byte-perfect for small/medium
code (proven). For 100k code the practical options are (a) fast chunked delivery
(~99.2%, ~20min) + manual/count spot-check, or (b) redesign verify to scale —
far fewer, larger verify chunks + a bounded OCR budget so per-chunk overhead
doesn't dominate, and a watchdog that fails fast instead of stalling. Item:
PASTE-014 (scale-aware verify) before claiming hands-off byte-perfect at 100k.

### Build-persistence root cause (the recurring "reverts to baseline")
- `RkLunch.sh` promotes a staged build with an unconditional `mv -f` and has NO
  rollback/failsafe — so `dev_deploy -i` IS permanent at the boot level.
- The reverts were the **cloud auto-updater** (`auto_update_enabled: true`,
  api.jetkvm.com): it downloads the official release, stages `jetkvm_app.update`,
  and auto-reboots → the next boot's `mv -f` overwrites the custom build.
- **Fix:** disable auto-update (web UI → Settings → General → Auto Update; flips
  `auto_update_enabled` to false, persists in `/userdata/kvm_config.json`,
  survives reboot). Confirmed: feature build now persists across reboot with
  en-US layout intact. (Official docs: jetkvm.com/docs/advanced-usage/ota-updates.)
