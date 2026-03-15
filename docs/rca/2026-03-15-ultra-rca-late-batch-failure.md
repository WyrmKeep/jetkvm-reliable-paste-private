# Ultra RCA: Late-Batch Paste Failure Near Batch ~201

Date: 2026-03-15
Repo: `WyrmKeep/jetkvm-reliable-paste-private`
Context: User reports very large pastes now work for a long time, then fail late (around batch ~201 in one run). File-backed mode, textarea mode, and increasingly aggressive timings all point to a remaining late-stage failure mode rather than the original overlap bug.

---

## Executive summary

The original overlap/cancellation bug is no longer the main culprit.
The strongest remaining root cause is that the current patch is still **open-loop with respect to the actual target consuming text**, while also **underestimating actual HID macro payload size** and running at very aggressive timings.

On top of that, the device-side HID write path contains a serious reliability flaw:

> HID report write timeouts are treated as **success**.

This means the backend can report a macro as completed even if some keyboard reports were never actually written to the USB gadget device.

That is currently the highest-confidence explanation for:
- long successful runs
- sudden tail corruption
- “batches done” while the host still appears to be processing or mangling the tail

---

## Ranked root-cause hypotheses

## 1. Silent HID write drops due to timeout swallowing
**Confidence:** High

### Evidence
In the USB gadget write path:
- `internal/usbgadget/utils.go`
- `DefaultWriteTimeout` is `10ms`
- if a write hits a timeout, the code logs it but then returns `nil`

### Why this matters
During sustained long-running pastes, the backend may attempt many HID writes in quick succession.
If the gadget device stalls even briefly, writes can time out.
But because the timeout is swallowed, the macro executor continues and later reports completion.

### Practical effect
The system believes the paste succeeded, while the host actually missed some reports.
That maps extremely well to:
- late corruption
- missing or mangled tail text
- no explicit reported error

---

## 2. Completion is device-local, not host-consumption-aware
**Confidence:** High

### Evidence
Paste completion waits for backend macro state (`KeyboardMacroState`) to go false.
That only means:
- the backend finished executing the macro loop
- not that the focused host application finished consuming/rendering all text

### Why this matters
The target app/editor/textarea/shell can lag behind the USB gadget feed.
At high throughput, especially late in long pastes, the host-side consumer may still be processing input after JetKVM thinks the macro is done.

### Practical effect
The UI and scheduler are more correct than before, but still not a true end-to-end ACK.
This can explain:
- “batches finished but it kept typing”
- tail instability after long successful runs

---

## 3. Actual HID payload sizes are larger than the patch assumes
**Confidence:** High

### Evidence
Batch budgeting currently estimates HID size based on logical steps.
But `executeMacroRemote()` expands each logical step into roughly:
- press step
- reset step

So actual HID macro size is roughly 2x the pre-send estimate.

### Practical effect
Even when the UI believes it is keeping batch size conservative, the actual on-wire macro can still be much larger than intended.
This matches previously observed log payloads around ~3930 bytes.

---

## 4. Current “reliable” mode is still much faster than upstream default
**Confidence:** Medium-high

### Evidence
Upstream default remote macro timing is much slower than the private branch’s tuned values.
Even “reliable” in the private build is significantly more aggressive than upstream stock behavior.

### Practical effect
This does not mean the patch is wrong, but it means late-stage target overload remains plausible even after batching improvements.

---

## 5. HID handler ordering guarantees weaken for long-running work
**Confidence:** Medium

### Evidence
The HID message handling path waits only 1 second around some goroutine processing before timing out and moving on.
That may not break every run, but it weakens the assumption that long-running macro work is perfectly serialized under all conditions.

### Practical effect
This is a contributor, but likely not the primary late-stage failure source.

---

## 6. The JetKVM paste modal / text-source path may still add pressure, but is not the top remaining RCA
**Confidence:** Medium-low as primary cause, medium as contributing factor

### Evidence
Switching between textarea and file-backed sources has changed ergonomics and some validation behavior, but the late-stage failure still clusters after many successful batches.

### Practical effect
The source UI path can still affect browser responsiveness or preprocessing cost, but the strongest technical evidence points more toward device-local write semantics and target-consumption mismatch.

---

## What is no longer the main RCA

### Old v1 overlap bug
That earlier bug was:
- next batch sent before prior batch completed
- backend canceled the current macro when a new one arrived

The current branch’s completion-aware scheduling mostly fixed that class of failure.
So the current late-stage problem should be treated as a **new RCA**, not just the old one persisting unchanged.

---

## Best next validation steps

1. Instrument/log actual HID write timeout counts in the backend.
2. Stop swallowing HID write timeouts as success, at least in debug/private builds.
3. Log actual runtime HID macro byte sizes after expansion, not just estimated pre-send size.
4. Add an optional extra target-settle/drain delay in large-paste mode for host-side consumption.
5. Compare behavior when pasting into:
   - plain terminal capture (`cat > file`)
   - simple editor
   - current problematic target

---

## Most likely real root cause today

If forced to pick one primary cause from the current evidence, it is:

> **Device-side HID write timeout/drop behavior plus optimistic completion semantics, amplified by larger-than-estimated macro payloads and aggressive throughput.**

That is the best-fit explanation for why the system can run cleanly for a long time and then only fail late, without obvious explicit errors.
