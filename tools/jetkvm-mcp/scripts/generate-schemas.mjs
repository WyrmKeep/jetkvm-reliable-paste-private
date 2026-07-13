import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { zodToJsonSchema } from "zod-to-json-schema";

import {
  SCHEMA_FILE_NAMES,
  generateJsonSchemaDocuments,
} from "../src/mcp/schemas.ts";
import {
  ACCEPTANCE_STORY_SCHEMA_NAME,
  acceptanceStorySchema,
} from "../src/stories/manifest.ts";
const mode = process.argv[2] ?? "--check";
if (mode !== "--check" && mode !== "--write") {
  throw new Error("Usage: node scripts/generate-schemas.mjs [--check|--write]");
}

const STORY_SCHEMA_FILE_NAME = "story-manifest.schema.json";
const GENERATED_SCHEMA_FILE_NAMES = [
  ...SCHEMA_FILE_NAMES,
  STORY_SCHEMA_FILE_NAME,
];

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const schemaDirectory = join(packageDirectory, "schemas");
const documents = {
  ...generateJsonSchemaDocuments(),
  [STORY_SCHEMA_FILE_NAME]: zodToJsonSchema(acceptanceStorySchema, {
    name: ACCEPTANCE_STORY_SCHEMA_NAME,
    $refStrategy: "root",
  }),
};
const serialized = Object.fromEntries(
  GENERATED_SCHEMA_FILE_NAMES.map((fileName) => [
    fileName,
    `${JSON.stringify(documents[fileName], null, 2)}\n`,
  ]),
);

if (mode === "--write") {
  await mkdir(schemaDirectory, { recursive: true });
  const existing = await readdir(schemaDirectory).catch(() => []);
  for (const fileName of existing) {
    if (
      fileName.endsWith(".json") &&
      !GENERATED_SCHEMA_FILE_NAMES.includes(fileName)
    ) {
      throw new Error(`Refusing to retain extra schema file: ${fileName}`);
    }
  }
  await Promise.all(
    GENERATED_SCHEMA_FILE_NAMES.map((fileName) =>
      writeFile(join(schemaDirectory, fileName), serialized[fileName], "utf8"),
    ),
  );
  process.stdout.write(
    `wrote ${GENERATED_SCHEMA_FILE_NAMES.length} schema files\n`,
  );
} else {
  const existing = (await readdir(schemaDirectory).catch(() => []))
    .filter((fileName) => fileName.endsWith(".json"))
    .sort();
  const owned = existing.filter((fileName) =>
    GENERATED_SCHEMA_FILE_NAMES.includes(fileName),
  );
  const unknown = existing.filter(
    (fileName) => !GENERATED_SCHEMA_FILE_NAMES.includes(fileName),
  );
  if (
    JSON.stringify(owned) !== JSON.stringify(GENERATED_SCHEMA_FILE_NAMES) ||
    unknown.length > 0
  ) {
    throw new Error(
      `Schema inventory mismatch: expected ${GENERATED_SCHEMA_FILE_NAMES.join(", ")}; found ${existing.join(", ")}`,
    );
  }
  for (const fileName of GENERATED_SCHEMA_FILE_NAMES) {
    const actual = await readFile(join(schemaDirectory, fileName), "utf8");
    if (actual !== serialized[fileName]) {
      throw new Error(`Stale schema file: ${fileName}`);
    }
  }
  process.stdout.write(
    `checked ${GENERATED_SCHEMA_FILE_NAMES.length} schema files\n`,
  );
}
