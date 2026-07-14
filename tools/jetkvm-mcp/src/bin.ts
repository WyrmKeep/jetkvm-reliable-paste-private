#!/usr/bin/env node

import { runJetKvmMcpCli } from "./cli.js";

process.exitCode = await runJetKvmMcpCli();
