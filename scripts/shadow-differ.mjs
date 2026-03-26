#!/usr/bin/env node
// Structured JSON differ for shadow comparison.
// Recursively walks two JSON trees, classifies leaf differences as
// rounding (numeric epsilon), known_fix (whitelisted TS bug fixes),
// or unexpected. Outputs a verdict JSON report.
//
// Usage: node scripts/shadow-differ.mjs <ts-file> <shell-file> [filename-hint]

import { readFileSync } from 'node:fs';

const EPSILON = 0.011; // covers jq vs JS Math.round at 0.5 boundaries
const ID_KEYS = ['campaign_id', 'adset_id', 'ad_id', 'id'];

const [tsPath, shellPath, filenameHint = ''] = process.argv.slice(2);
if (!tsPath || !shellPath) {
  console.error('Usage: shadow-differ.mjs <ts-file> <shell-file> [filename-hint]');
  process.exit(2);
}

const tsData = JSON.parse(readFileSync(tsPath, 'utf8'));
const shellData = JSON.parse(readFileSync(shellPath, 'utf8'));

const diffs = [];
let totalLeaves = 0;

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function findIdKey(arr) {
  if (arr.length === 0 || !isObject(arr[0])) return null;
  return ID_KEYS.find(k => k in arr[0]) ?? null;
}

function indexById(arr, key) {
  const map = new Map();
  for (const item of arr) map.set(String(item[key]), item);
  return map;
}

function isKnownFix(path, tsVal, shellVal) {
  // Bug fix: top_by_spend — TS outputs all maintain adsets, shell truncated to 5
  if (/\.maintain\.top_by_spend/.test(path) && Array.isArray(tsVal) && Array.isArray(shellVal)) {
    return tsVal.length > shellVal.length;
  }
  // Bug fix: files_skipped — shell produces [""], TS produces []
  if (/files_skipped/.test(path)) {
    if (Array.isArray(tsVal) && Array.isArray(shellVal)) {
      const tsEmpty = tsVal.length === 0;
      const shellBogus = shellVal.length === 1 && shellVal[0] === '';
      return tsEmpty && shellBogus;
    }
  }
  return false;
}

function classify(path, tsVal, shellVal) {
  // Both numbers — check epsilon
  if (typeof tsVal === 'number' && typeof shellVal === 'number') {
    if (Math.abs(tsVal - shellVal) < EPSILON) return 'rounding';
  }
  // Null vs 0 — common jq/JS difference for zero-division
  if ((tsVal === null && shellVal === 0) || (tsVal === 0 && shellVal === null)) {
    return 'rounding';
  }
  return 'unexpected';
}

function compare(tsVal, shellVal, path) {
  // Identical
  if (tsVal === shellVal) {
    if (!isObject(tsVal) && !Array.isArray(tsVal)) totalLeaves++;
    return;
  }

  // Known fix check (before descending into arrays/objects)
  if (isKnownFix(path, tsVal, shellVal)) {
    diffs.push({ path, class: 'known_fix', ts: summarize(tsVal), shell: summarize(shellVal) });
    return;
  }

  // Both objects
  if (isObject(tsVal) && isObject(shellVal)) {
    const allKeys = new Set([...Object.keys(tsVal), ...Object.keys(shellVal)]);
    for (const key of allKeys) {
      compare(tsVal[key], shellVal[key], `${path}.${key}`);
    }
    return;
  }

  // Both arrays
  if (Array.isArray(tsVal) && Array.isArray(shellVal)) {
    const idKey = findIdKey(tsVal) ?? findIdKey(shellVal);
    if (idKey) {
      // Match by ID
      const tsMap = indexById(tsVal, idKey);
      const shellMap = indexById(shellVal, idKey);
      const allIds = new Set([...tsMap.keys(), ...shellMap.keys()]);
      for (const id of allIds) {
        const t = tsMap.get(id);
        const s = shellMap.get(id);
        if (t === undefined) {
          diffs.push({ path: `${path}[${idKey}=${id}]`, class: 'unexpected', ts: undefined, shell: summarize(s) });
        } else if (s === undefined) {
          diffs.push({ path: `${path}[${idKey}=${id}]`, class: 'unexpected', ts: summarize(t), shell: undefined });
        } else {
          compare(t, s, `${path}[${idKey}=${id}]`);
        }
      }
    } else {
      // Positional comparison
      const len = Math.max(tsVal.length, shellVal.length);
      for (let i = 0; i < len; i++) {
        compare(tsVal[i], shellVal[i], `${path}[${i}]`);
      }
    }
    return;
  }

  // Leaf difference
  totalLeaves++;
  const cls = classify(path, tsVal, shellVal);
  diffs.push({ path, class: cls, ts: tsVal, shell: shellVal });
}

function summarize(val) {
  if (Array.isArray(val)) return `[${val.length} items]`;
  if (isObject(val)) return '{...}';
  return val;
}

compare(tsData, shellData, '$');

const rounding = diffs.filter(d => d.class === 'rounding').length;
const knownFixes = diffs.filter(d => d.class === 'known_fix').length;
const unexpected = diffs.filter(d => d.class === 'unexpected').length;

let verdict = 'MATCH';
if (unexpected > 0) verdict = 'UNEXPECTED_DIFFS';
else if (rounding > 0 || knownFixes > 0) verdict = 'ACCEPTABLE_DIFFS';

const report = {
  file: filenameHint || tsPath,
  verdict,
  total_leaves: totalLeaves,
  rounding_diffs: rounding,
  known_fixes: knownFixes,
  unexpected_diffs: unexpected,
  details: diffs,
};

console.log(JSON.stringify(report, null, 2));
process.exit(unexpected > 0 ? 1 : 0);
