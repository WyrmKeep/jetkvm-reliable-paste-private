import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STORY_FILENAME_PATTERN = /^(?:0[1-9]|1\d|2[0-4])-[a-z0-9-]+\.json$/u;

export async function copyStoryAssets(sourceDirectory, destinationDirectory) {
  sourceDirectory = resolve(sourceDirectory);
  destinationDirectory = resolve(destinationDirectory);
  const entries = await readdir(sourceDirectory, { withFileTypes: true });
  const stories = entries
    .filter((entry) => STORY_FILENAME_PATTERN.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (stories.length !== 24 || stories.some((entry) => !entry.isFile())) {
    throw new Error(
      "Runtime story assets must contain exactly 24 regular canonical JSON files.",
    );
  }
  await mkdir(destinationDirectory, { recursive: true });
  for (const story of stories) {
    await copyFile(
      join(sourceDirectory, story.name),
      join(destinationDirectory, story.name),
    );
  }
  return Object.freeze(stories.map((story) => story.name));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const copied = await copyStoryAssets(
    join(packageRoot, "src/stories"),
    join(packageRoot, "dist/stories"),
  );
  process.stdout.write(`Copied ${copied.length} canonical story assets.\n`);
}
