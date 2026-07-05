# JetKVM `.36` Manual Paste Checklist

**Target device:** `192.168.1.36`
**Required device build revision/SHA:** `58eac4f7216a6bd7963783c015a8a7a1de952d29`
**Required build identity:** `jetkvm-50248789f5727d74:fb5a6bdb12ef`
**Required keyboard layout setting:** `en-UK`

Before step 1, open `http://192.168.1.36/metrics` in a browser and confirm the unauthenticated `jetkvm_build_info{revision="58eac4f7216a6bd7963783c015a8a7a1de952d29",...}` metric reports the exact device build revision/SHA. Do not run this checklist on any other build. Results from a pre-parity build do not count.

Do not use SSH or scripts on the `.36`-attached host for this checklist. Each result must be verifiable only by eye or by the target app's own character counter.

## Preflight

- [ ] Pass / [ ] Fail: Browser view of `http://192.168.1.36/metrics` shows `jetkvm_build_info` revision/SHA `58eac4f7216a6bd7963783c015a8a7a1de952d29`.
- [ ] Pass / [ ] Fail: Device keyboard layout is `en-UK`.
- [ ] Pass / [ ] Fail: The target app is open, focused, empty, and either has a visible character counter or the full pasted text can be checked by eye.

## Test 1: `<>` trigger paste

1. Clear the target app input.
2. In the JetKVM Paste Text modal, paste exactly this text:

```text
F16 <> trigger <><><> after-angle sentinel: AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 END
```

3. Use the Reliable paste profile.
4. Expected result:
   - Exact text appears, including every `<` and `>`.
   - The text after the `<><><>` region remains mixed case exactly as printed.
   - Expected target-app character count: **269**.

- [ ] Pass / [ ] Fail: Exact text matches by eye.
- [ ] Pass / [ ] Fail: Character counter shows `269` if the target app has a counter.

## Test 2: shifted-symbol paste

1. Clear the target app input.
2. In the JetKVM Paste Text modal, paste exactly this text:

```text
@ " # ~ \ | £
```

3. Use the Reliable paste profile.
4. Expected result:
   - Exact text appears as `@ " # ~ \ | £`.
   - No US/UK layout swaps appear. In particular, `@`, `"`, `#`, `~`, `\`, `|`, and `£` must each match exactly.
   - Expected target-app character count: **13**.

- [ ] Pass / [ ] Fail: Exact text matches by eye.
- [ ] Pass / [ ] Fail: Character counter shows `13` if the target app has a counter.

## Result

- [ ] Overall pass: preflight, Test 1, and Test 2 all passed.
- [ ] Overall fail: one or more checks failed.

If anything fails, record which line or symbol first differs and whether the character counter was lower, higher, or exactly correct.
