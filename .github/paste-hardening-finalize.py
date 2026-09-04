from pathlib import Path
import json
import subprocess

manifest = Path('/tmp/paste-hardening-files.json')
changed = set(json.loads(manifest.read_text()))
def replace(path, old, new, count=1):
    p = Path(path)
    text = p.read_text()
    assert text.count(old) == count, (path, old, text.count(old))
    p.write_text(text.replace(old, new))
    changed.add(path)

# Keep macro admission unchanged. A synchronous admission change also needs a
# full HID queue/lock/teardown saturation proof; it is not bundled into pacing.
Path('hidrpc.go').write_bytes(subprocess.check_output(['git', 'show', '968bfd5ab9e55261adf26ab29f5fd8e9966d1782:hidrpc.go']))
replace('ui/src/hooks/useKeyboard.paste.test.ts', 'vi.mock("react", () => ({', '''vi.mock("@/utils", () => ({
  sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
}));
vi.mock("react", () => ({''')
replace('ui/src/utils/pasteMacro.test.ts', '  buildPasteMacroBatches,', '  DEFAULT_LARGE_PASTE_POLICY,\n  partitionBatchesByChunkChars,\n  buildPasteMacroBatches,')
p = Path('ui/src/utils/pasteMacro.test.ts')
p.write_text(p.read_text() + '''

describe("bounded paste checkpoints", () => {
  test("pins the default threshold and source-character chunk budget", () => {
    expect(DEFAULT_LARGE_PASTE_POLICY).toEqual({
      autoThresholdChars: 1024,
      chunkChars: 1024,
      chunkPauseMs: 250,
      chunkDrainTimeoutFloorMs: 60000,
    });
  });
  test.each([127, 128, 129, 1023, 1024, 1025, 4999, 5000, 5001])(
    "preserves every character and batch at size %s",
    length => {
      const build = buildPasteMacroBatches("a".repeat(length), keyboard, 20, 128, 2318);
      const chunks = partitionBatchesByChunkChars(build.batchStats, DEFAULT_LARGE_PASTE_POLICY.chunkChars);
      expect(build.invalidChars).toEqual([]);
      expect(chunks.reduce((sum, chunk) => sum + chunk.sourceChars, 0)).toBe(length);
      expect(chunks.every(chunk => chunk.sourceChars > 0 && chunk.sourceChars <= 1024)).toBe(true);
      expect(chunks[0].batchStartIndex).toBe(0);
      expect(chunks.at(-1)?.batchEndIndex).toBe(build.batches.length);
      for (let i = 1; i < chunks.length; i++) {
        expect(chunks[i].batchStartIndex).toBe(chunks[i - 1].batchEndIndex);
      }
      if (length === 1025) expect(chunks.map(chunk => chunk.sourceChars)).toEqual([1024, 1]);
    },
  );
  test("keeps expanded mappings intact across batch and checkpoint boundaries", () => {
    const text = ("a".repeat(127) + "é^").repeat(10);
    const build = buildPasteMacroBatches(text, keyboard, 45, 128, 2318);
    const chunks = partitionBatchesByChunkChars(build.batchStats, 1024);
    expect(build.batches.flat()).toEqual(buildPasteMacroSteps(text, keyboard, 45).steps);
    expect(chunks.reduce((sum, chunk) => sum + chunk.sourceChars, 0)).toBe(text.length);
    expect(build.batchStats.every(stat => stat.stepCount <= 128 && stat.estimatedBytes <= 2318)).toBe(true);
    expect(chunks.every(chunk => chunk.sourceChars <= 1024)).toBe(true);
    // The 127 ordinary keys leave too little room for the two-step accent.
    expect(build.batches[0]).toHaveLength(127);
    expect(build.batches[1][0].keys).toEqual(["Quote"]);
    expect(build.batches[1][1].keys).toEqual(["KeyE"]);
  });
  test("budgets slow repair beyond the old profile timeout", () => {
    const build = buildPasteMacroBatches("a".repeat(1024), keyboard, 45, 128, 2318);
    const original = estimatePasteDrainTimeoutMs(build.batchStats, 20, 60000);
    const repair = estimatePasteDrainTimeoutMs(build.batchStats, 45, 60000);
    expect(repair).toBeGreaterThan(original);
    expect(repair).toBeGreaterThan(1024 * (10 + 45));
  });
});
''')
changed.add(str(p))
replace('docs/paste-reliability.md', '''Macro admission stays synchronous in the ordered keyboard queue rather than
leaving an enqueue worker behind after a one-second watchdog. Cancellation still
uses its separate HID queue. This does not remove all upstream buffering or make
cancellation over a saturated network instantaneous.''', '''Macro admission and queue architecture are unchanged in this PR. The one-second
handler watchdog can leave an enqueue worker in flight; ordered network delivery
alone is not proof of ordered admission. Fixing that path requires a separate
saturation/teardown review: making admission synchronous without addressing the
shared HID queue lock could create a full-queue deadlock. Cancellation still uses
its separate HID queue, but delivery over a saturated network is not instantaneous.''')
replace('docs/tickets/PASTE-014.md', '''character target and a 250 ms inter-chunk pause''', '''character target and a 250 ms inter-chunk pause''', 0) if False else None
replace('docs/tickets/PASTE-014.md', '''20 cps, bounds modal chunks, prevents paste catch-up, preserves ordered macro
admission, and adds focused input/transport safeguards and tests.''', '''20 cps, bounds modal chunks, prevents paste catch-up, and adds focused
input/transport safeguards and tests. Queue admission is deferred for a separate
saturation and teardown proof.''')
# The prepared source has misleading historical comments; leave the public
# semantics explicit at the current entry points without deleting measurements.
replace('ui/src/hooks/useKeyboard.ts', '''    // Capability is device-level''', '''    // Capability is device-level''', 0) if False else None

# Include this temporary file's deletion in the final branch-local commit.
changed.add('.github/paste-hardening-finalize.py')
manifest.write_text(json.dumps(sorted(changed)))
Path('.github/paste-hardening-finalize.py').unlink()
