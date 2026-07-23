#!/usr/bin/env node
/**
 * DG-MCP CLI entry.
 *
 *   dg-mcp [--waveforms <path>...] [--waveforms-dir <dir>] [--library-dir <dir>]
 *
 * Speaks MCP over stdio so any MCP-capable LLM client (Claude Desktop, etc.)
 * can drive a DG-Lab Coyote 2.0 / 3.0 device through tools.
 */

import { readdir } from 'node:fs/promises';
import { join, isAbsolute, resolve, extname } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { DeviceManager } from './device-manager.js';
import { NodeWaveformLibrary } from './waveform-library.js';
import { runStdioServer } from './server.js';

interface ParsedArgs {
  waveformPaths: string[];
  waveformsDir: string | null;
  libraryDir: string | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    waveformPaths: [],
    waveformsDir: null,
    libraryDir: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--waveforms') {
      const v = argv[++i];
      if (v) out.waveformPaths.push(v);
    } else if (arg === '--waveforms-dir') {
      out.waveformsDir = argv[++i] ?? null;
    } else if (arg === '--library-dir') {
      out.libraryDir = argv[++i] ?? null;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg === '--version' || arg === '-v') {
      console.log('dg-mcp 1.1.0');
      process.exit(0);
    } else if (arg && arg.startsWith('--')) {
      console.error(`unknown flag: ${arg}`);
      process.exit(2);
    }
  }

  return out;
}

function printHelp(): void {
  console.log(`dg-mcp — Model Context Protocol server for DG-Lab Coyote 2.0/3.0

Usage:
  dg-mcp [options]

Options:
  --waveforms <path>      Add a .pulse or .zip file at startup (repeatable)
  --waveforms-dir <dir>   Add every .pulse / .zip file in a directory
  --library-dir <dir>     Persist user-imported / AI-designed waveforms here
  --help, -h              Show this help
  --version, -v           Show version

Environment:
  DG_MCP_WAVEFORMS        Colon-separated list of waveform paths (alt. to --waveforms)
  DG_MCP_WAVEFORMS_DIR    Same as --waveforms-dir
  DG_MCP_LIBRARY_DIR      Same as --library-dir

Example (Claude Desktop config):
  {
    "mcpServers": {
      "dg-lab": {
        "command": "npx",
        "args": ["dg-mcp", "--waveforms-dir", "/Users/me/wave-pack"]
      }
    }
  }
`);
}

async function expandWaveformPaths(parsed: ParsedArgs): Promise<string[]> {
  const collected = new Set<string>();

  for (const p of parsed.waveformPaths) {
    collected.add(resolveAbs(p));
  }

  const envWaveforms = process.env.DG_MCP_WAVEFORMS;
  if (envWaveforms) {
    for (const p of envWaveforms.split(':').filter(Boolean)) {
      collected.add(resolveAbs(p));
    }
  }

  const dirs: string[] = [];
  if (parsed.waveformsDir) dirs.push(resolveAbs(parsed.waveformsDir));
  const envDir = process.env.DG_MCP_WAVEFORMS_DIR;
  if (envDir) dirs.push(resolveAbs(envDir));

  for (const dir of dirs) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    const entries = await readdir(dir);
    for (const entry of entries) {
      const ext = extname(entry).toLowerCase();
      if (ext === '.pulse' || ext === '.zip') {
        collected.add(join(dir, entry));
      }
    }
  }

  return [...collected];
}

function resolveAbs(p: string): string {
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const libraryDir = parsed.libraryDir ?? process.env.DG_MCP_LIBRARY_DIR ?? null;

  const waveformLibrary = new NodeWaveformLibrary({
    persistDir: libraryDir ?? undefined,
  });
  await waveformLibrary.init();

  const waveformPaths = await expandWaveformPaths(parsed);
  for (const path of waveformPaths) {
    const result = await waveformLibrary.importPath(path);
    if (result.errors.length > 0) {
      for (const err of result.errors) {
        process.stderr.write(`[dg-mcp] failed to load ${err.file}: ${err.reason}\n`);
      }
    }
    if (result.loaded.length > 0) {
      process.stderr.write(
        `[dg-mcp] loaded ${result.loaded.length} waveform(s) from ${path}\n`,
      );
    }
  }

  const deviceManager = new DeviceManager();

  await runStdioServer({ deviceManager, waveformLibrary });
}

main().catch((err) => {
  process.stderr.write(`[dg-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : err}\n`);
  process.exit(1);
});
