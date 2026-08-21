#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Stage an app's `bundle.resources` into a plain directory, the way the Tauri
// installer bundlers do. build.sh uses this to assemble the standalone
// (portable) builds: `tauri build --no-bundle` produces only the executable, so
// nothing copies the tools/ scripts, app/js/libs/ and the Node runtime next to
// it, and the app would start and then fail every action.
//
// The destination is the directory the app resolves as its resource dir
// (tauri_utils::platform::resource_dir):
//   Windows: the folder holding the .exe
//   Linux:   <exe dir>/../lib/<productName>
//   macOS:   unused - the `app` bundler stages Contents/Resources itself
//
// The copy rules mirror tauri_utils::resources::ResourcePathsIter for a map:
//   "dir/*": "target"  -> every matched *file*  -> target/<file name>
//   "dir":   "target"  -> every file under dir  -> target/<path relative to dir>
//   "file": "target"  -> the file             -> target (target/<name> if "")
// Directories matched by a glob are skipped, and a glob matching nothing is an
// error, both exactly as the bundler behaves.
//
// Usage: node stage-portable.js <src-tauri dir> <dest dir>

"use strict";

const fs = require("fs");
const path = require("path");

function fail(msg) {
  console.error(`stage-portable: ${msg}`);
  process.exit(1);
}

// Expand `pattern` (relative to `base`, '*' allowed in any segment) into paths.
function expand(base, pattern) {
  const segments = pattern.split(/[\\/]+/).filter((s) => s.length && s !== ".");

  const walk = (dir, i) => {
    if (i === segments.length) return fs.existsSync(dir) ? [dir] : [];
    const segment = segments[i];
    if (!segment.includes("*")) return walk(path.join(dir, segment), i + 1);

    const re = new RegExp(
      `^${segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/\\\\]*")}$`
    );
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => re.test(e.name))
      .flatMap((e) => walk(path.join(dir, e.name), i + 1));
  };

  return walk(base, 0);
}

function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? filesUnder(p) : [p];
  });
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  // The bundled Node runtime has to stay executable.
  fs.chmodSync(dest, fs.statSync(src).mode & 0o777);
}

const [srcTauri, dest] = process.argv.slice(2);
if (!srcTauri || !dest) fail("usage: stage-portable.js <src-tauri dir> <dest dir>");

const confPath = path.join(srcTauri, "tauri.conf.json");
if (!fs.existsSync(confPath)) fail(`no tauri.conf.json in ${srcTauri}`);
const resources = (JSON.parse(fs.readFileSync(confPath, "utf8")).bundle || {}).resources;

if (!resources) fail(`${confPath} declares no bundle.resources`);
if (Array.isArray(resources)) fail("only the map form of bundle.resources is supported");

let count = 0;
for (const [pattern, targetSpec] of Object.entries(resources)) {
  if (pattern.includes("**")) fail(`'**' patterns are not supported (${pattern})`);
  // resource_relpath(): the target is always relative to the resource dir.
  const target = targetSpec
    .split(/[\\/]+/)
    .filter((s) => s.length && s !== ".")
    .join(path.sep);

  if (pattern.includes("*")) {
    const matches = expand(srcTauri, pattern).filter((p) => fs.statSync(p).isFile());
    if (matches.length === 0) fail(`no file matched '${pattern}' (from ${srcTauri})`);
    for (const src of matches) {
      copyFile(src, path.join(dest, target, path.basename(src)));
      count++;
    }
    continue;
  }

  const src = path.resolve(srcTauri, pattern);
  if (!fs.existsSync(src)) fail(`resource not found: '${pattern}' (${src})`);
  if (fs.statSync(src).isDirectory()) {
    for (const f of filesUnder(src)) {
      copyFile(f, path.join(dest, target, path.relative(src, f)));
      count++;
    }
  } else {
    copyFile(src, target ? path.join(dest, target) : path.join(dest, path.basename(src)));
    count++;
  }
}

console.log(`    staged ${count} resource file(s) -> ${dest}`);
