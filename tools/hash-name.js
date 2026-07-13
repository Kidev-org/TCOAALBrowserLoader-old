#!/usr/bin/env node
/*
 * TCOAAL Browser Player
 * Copyright (C) 2026 kidev
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at your
 * option) any later version. This program is distributed in the hope that it
 * will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty
 * of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero
 * General Public License for more details: <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/*
 * hash-name.js: forward-hash a logical asset path the same way the remaster
 * does (hashPath() in build-tomb-mod.js / CLAUDE.md), and/or search for which
 * candidate name(s) produce a given on-disk hash.
 *
 * There is no way to invert sha256, so recovering a name from a hash is
 * always a forward-hash-and-compare: guess a logical path, hash it, see if it
 * matches. This script automates that guessing.
 *
 * Note: ".k9a" is NOT part of this. It's the old pre-remaster on-disk
 * container (logical names, unhashed directory layout, real extension stored
 * in the file header): a completely different asset layout, not a filename
 * variant that ever gets hashed. Under the current hashed layout the only
 * thing that goes into hashPath() is "<dir>/<name>.<realExt>" (e.g. ".png"
 * for img/*, ".ogg" for audio/*).
 *
 * Usage:
 *   # Plain forward hash of one or more full logical paths.
 *   node tools/hash-name.js img/parallaxes/ground2.png
 *
 *   # Convenience: --dir prefixes bare stems and appends the directory's
 *   # default extension (.png for img/*, .ogg for audio/*) when the stem
 *   # doesn't already have one.
 *   node tools/hash-name.js --dir img/parallaxes ground2 ground3.png
 *
 *   # Reverse search: try candidate name(s) against a known hash. With no
 *   # candidates given, falls back to the curated name list already bundled
 *   # in map-filenames.json for that directory (same list extract-project.js
 *   # uses to recover human names).
 *   node tools/hash-name.js --dir img/parallaxes --find 0bd3fbd677797b85
 *   node tools/hash-name.js --dir img/parallaxes --find 0bd3fbd677797b85 file myfile
 *   node tools/hash-name.js --dir img/parallaxes --find 0bd3fbd677797b85 --wordlist names.txt
 */

"use strict";

const fs = require("fs");
const { hashPath } = require("./build-tomb-mod.js");
const { ASSET_NAMES, dirExt, dirSuffix, toName } = require("./map-names.js");

function usage() {
  console.error(
    "Usage:\n" +
      "  node tools/hash-name.js <logicalPath...>\n" +
      "  node tools/hash-name.js --dir <dir> <stem...>\n" +
      "  node tools/hash-name.js --dir <dir> --find <hash> [stem...] [--wordlist <file>]\n",
  );
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { dir: null, find: null, wordlist: null, stems: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") opts.dir = argv[++i];
    else if (a === "--find") opts.find = argv[++i];
    else if (a === "--wordlist") opts.wordlist = argv[++i];
    else if (a === "-h" || a === "--help") usage();
    else opts.stems.push(a);
  }
  return opts;
}

// If the stem already has an extension, hash it verbatim: the caller fully
// specified the name (including any "[BUST]" suffix). Otherwise try it both
// with the directory's default extension + suffix (mirrors map-names.js's
// round-trip: name + suffix + ext) and bare (no extension at all).
function candidateLogicalPaths(dir, stem) {
  if (/\.[^./]+$/.test(stem)) return [`${dir}/${stem}`];
  const named = `${dir}/${stem}${dirSuffix(dir)}${dirExt(dir)}`;
  const bare = `${dir}/${stem}`;
  return [named, bare];
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Reverse search: hash candidates and/or the curated list, report matches.
  if (opts.find) {
    if (!opts.dir) usage();
    const target = opts.find.toLowerCase();

    let stems = [...opts.stems];
    if (opts.wordlist) {
      stems.push(
        ...fs
          .readFileSync(opts.wordlist, "utf8")
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean),
      );
    }

    let found = false;

    // Curated list first (exact round-trip already used by extract-project.js).
    if (stems.length === 0) {
      const known = toName(opts.dir, target);
      if (known !== target) {
        console.log(`MATCH  ${opts.dir}/${known}  ->  ${target}  (curated name)`);
        found = true;
      }
    }

    // Explicit guesses / wordlist: forward-hash every variant and compare.
    for (const stem of stems) {
      for (const logical of candidateLogicalPaths(opts.dir, stem)) {
        const hashed = hashPath(logical).split("/").pop();
        if (hashed.toLowerCase() === target) {
          console.log(`MATCH  ${logical}  ->  ${hashed}`);
          found = true;
        }
      }
    }

    if (!found) {
      const source =
        stems.length > 0 ? `${stems.length} candidate(s)` : "the curated map-filenames.json list";
      console.log(`No match for "${opts.find}" in ${opts.dir} among ${source}.`);
    }
    return;
  }

  // Forward mode: hash explicit stems (with --dir) or full logical paths.
  if (opts.stems.length === 0) usage();
  for (const stem of opts.stems) {
    if (opts.dir) {
      for (const logical of candidateLogicalPaths(opts.dir, stem)) {
        console.log(`${logical}  ->  ${hashPath(logical)}`);
      }
    } else {
      console.log(`${stem}  ->  ${hashPath(stem)}`);
    }
  }
}

main();
