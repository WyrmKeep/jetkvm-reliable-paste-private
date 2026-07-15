import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { copyStoryAssets } from "./copy-runtime-assets.mjs";

test("copies exactly the 24 canonical story JSON assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "jetkvm-story-assets-"));
  const source = join(root, "source");
  const destination = join(root, "destination");
  await mkdir(source);
  try {
    for (let index = 1; index <= 24; index += 1) {
      const name = `${String(index).padStart(2, "0")}-story.json`;
      await writeFile(join(source, name), `${JSON.stringify({ index })}\n`);
    }
    await writeFile(join(source, "manifest.ts"), "not copied\n");
    const copied = await copyStoryAssets(source, destination);
    assert.equal(copied.length, 24);
    assert.deepEqual(
      JSON.parse(await readFile(join(destination, "24-story.json"), "utf8")),
      {
        index: 24,
      },
    );
    assert.rejects(readFile(join(destination, "manifest.ts")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed when a canonical story asset is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "jetkvm-story-assets-missing-"));
  const source = join(root, "source");
  await mkdir(source);
  try {
    await writeFile(join(source, "01-story.json"), "{}\n");
    await assert.rejects(
      copyStoryAssets(source, join(root, "destination")),
      /exactly 24/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
