import { mkdir, rm } from "node:fs/promises";

const packageRoot = new URL("../", import.meta.url);
await rm(new URL("dist/", packageRoot), { recursive: true, force: true });
await mkdir(new URL("dist/", packageRoot), { recursive: true });
await mkdir(new URL("schemas/", packageRoot), { recursive: true });
