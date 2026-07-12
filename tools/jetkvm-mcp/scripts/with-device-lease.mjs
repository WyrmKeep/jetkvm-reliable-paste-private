#!/usr/bin/env node

import { runDeviceLeaseCli } from "../src/deviceLeaseRunner.ts";

process.exitCode = await runDeviceLeaseCli();
