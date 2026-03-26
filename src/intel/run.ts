import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pull } from './pull.js';
import { analyzeCreatives } from './creatives.js';
import type { PullOptions } from './pull.js';
import type { RunResult } from './types.js';

let _ffmpegCached: boolean | undefined;

/** Check whether ffmpeg and ffprobe are available on $PATH. */
export function hasFfmpeg(): boolean {
  if (_ffmpegCached !== undefined) return _ffmpegCached;
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'pipe', timeout: 5_000 });
    execFileSync('ffprobe', ['-version'], { stdio: 'pipe', timeout: 5_000 });
    _ffmpegCached = true;
  } catch {
    _ffmpegCached = false;
  }
  return _ffmpegCached;
}

/** Reset the hasFfmpeg cache — for testing only. */
export function _resetFfmpegCache(): void {
  _ffmpegCached = undefined;
}

/**
 * Full analysis pipeline: pull data → analyze creatives (if ffmpeg available).
 * Port of run-analysis.sh.
 */
export async function run(options?: PullOptions): Promise<RunResult> {
  const pullResult = await pull(options);

  // Phase 2: Visual creative analysis (if ffmpeg available)
  if (!hasFfmpeg()) {
    console.error('ffmpeg/ffprobe not installed. Skipping visual creative analysis.');
    console.error('  Install with: brew install ffmpeg');
    return { ...pullResult, creatives: undefined };
  }

  const mediaFile = path.join(pullResult.runDir, 'creative-media.json');
  if (!fs.existsSync(mediaFile)) {
    console.error('creative-media.json not found. Skipping visual creative analysis.');
    return { ...pullResult, creatives: undefined };
  }

  let mediaEntries: unknown[];
  try {
    mediaEntries = JSON.parse(fs.readFileSync(mediaFile, 'utf8'));
  } catch {
    console.error('Failed to parse creative-media.json. Skipping visual creative analysis.');
    return { ...pullResult, creatives: undefined };
  }

  if (!Array.isArray(mediaEntries) || mediaEntries.length === 0) {
    console.error('creative-media.json is empty. Skipping visual creative analysis.');
    return { ...pullResult, creatives: undefined };
  }

  console.error('');
  console.error('=== Phase 2: Visual Creative Analysis ===');
  const creatives = await analyzeCreatives({
    inputFile: mediaFile,
    dataDir: options?.dataDir,
    accessToken: options?.accessToken,
  });

  return { ...pullResult, creatives };
}
