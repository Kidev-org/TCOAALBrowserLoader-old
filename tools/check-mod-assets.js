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
 * check-mod-assets.js: find asset references a mod's *effective* data set
 * points at but that don't exist anywhere; not in the mod, not in the base
 * game it's meant to run against.
 *
 * "Effective" data set = the mod's version of a data file where it ships
 * one, otherwise the base game's version of that same file; mirroring how
 * the active-mod resolution in sw.js actually serves files at runtime
 * (mod-prefixed key first, base as fallback). This is what makes the check
 * meaningful for plugin-type mods too: they ship no data/ at all, so without
 * the base fallback there would be nothing to scan.
 *
 * Both --mod and --base accept any of the three on-disk shapes a www/ can be
 * in (plain decrypted dump, current hashed+encrypted install, old .k9a),
 * courtesy of resolveBaseBytes() in build-tomb-mod.js.
 *
 * The set of asset-bearing fields/event-commands/note-tags to look for is
 * NOT reimplemented here: it's the same table map-names.js already
 * maintains for the dialogue-bake round trip (transformDoc), run in a
 * read-only "collect" mode instead of a rewriting one.
 *
 * img/faces (bust images) get extra leniency: real mod folders are
 * inconsistent about the "[BUST]" tag; some faces have no bust variant,
 * some use the canonical bracket, some just tack on "BUST"/"_BUST" with no
 * brackets. All spellings are tried when checking existence; a match found
 * only via the non-bracketed forms is reported separately as "weird-format"
 * rather than either a false miss or a silent pass.
 *
 * Usage:
 *   node tools/check-mod-assets.js --mod <dir> --base <dir> [options]
 *
 *   --mod  <dir>      Mod folder (or its www/ directly).
 *   --base <dir>      Base game folder to check against (or its www/
 *                     directly).
 *   --exclude <file>  Skip this data file when scanning (repeatable). Matches
 *                     the logical path ("data/Animations.json"), a leading
 *                     "www/" is stripped, and matching also falls back to
 *                     just the basename ("Animations.json") or bare stem
 *                     ("Animations"). Useful for files like Animations.json,
 *                     whose stock RPG Maker MV template references battle SE
 *                     TCOAAL never shipped (the game has no combat).
 *   --json            Emit machine-readable JSON instead of the text report.
 *   -h, --help        Show this help.
 */

"use strict";

const path = require("path");
const {
  resolveBaseBytes,
  contentRoot,
  isFile,
  isDir,
  hashPath,
} = require("./build-tomb-mod.js");
const { transformDoc, dirExt, dirSuffix, isHashLike } = require("./map-names.js");
const { STD_DATA } = require("./extract-project.js");

function usage() {
  console.error(
    "Usage:\n" +
      "  node tools/check-mod-assets.js --mod <dir> --base <dir>" +
      " [--exclude <file>...] [--json]\n",
  );
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { mod: null, base: null, exclude: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--mod":
        opts.mod = argv[++i];
        break;
      case "--base":
        opts.base = argv[++i];
        break;
      case "--exclude":
        opts.exclude.push(argv[++i]);
        break;
      case "--json":
        opts.json = true;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        throw new Error("unknown argument: " + a);
    }
  }
  return opts;
}

/** Build the set of names an --exclude entry should match against: the
 *  logical path itself (leading "www/" stripped), its basename, and its
 *  bare stem (no extension); so "--exclude Animations",
 *  "--exclude Animations.json", and "--exclude www/data/Animations.json"
 *  all work. */
function excludeVariants(raw) {
  const logical = raw.replace(/^www\//, "");
  const base = logical.split("/").pop();
  const stem = base.replace(/\.[^.]+$/, "");
  return [logical, base, stem];
}

function buildExcludeSet(entries) {
  const set = new Set();
  for (const e of entries) for (const v of excludeVariants(e)) set.add(v);
  return set;
}

function isExcluded(excludeSet, logical) {
  if (excludeSet.size === 0) return false;
  for (const v of excludeVariants(logical)) {
    if (excludeSet.has(v)) return true;
  }
  return false;
}

/** Resolve a logical path against mod root first, then base root. Returns
 *  the decoded bytes, or null if present in neither. */
function resolveEffective(modRoot, baseRoot, logical) {
  return (
    resolveBaseBytes(modRoot, logical) || resolveBaseBytes(baseRoot, logical)
  );
}

function loadEffectiveJson(modRoot, baseRoot, logical) {
  const buf = resolveEffective(modRoot, baseRoot, logical);
  if (buf === null) return null;
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch (e) {
    console.error(`warning: ${logical}: ${e.message}`);
    return null;
  }
}

/** Build the list of standard data files plus every MapNNN.json id present
 *  in the effective MapInfos.json (falls back to the STD_DATA list alone if
 *  MapInfos can't be found/parsed), minus anything --exclude'd. */
function listDataFiles(modRoot, baseRoot, excludeSet) {
  const files = STD_DATA.map((name) => `data/${name}.json`);

  const infos = loadEffectiveJson(modRoot, baseRoot, "data/MapInfos.json");
  if (Array.isArray(infos)) {
    for (const entry of infos) {
      if (entry && Number.isInteger(entry.id)) {
        files.push(`data/Map${String(entry.id).padStart(3, "0")}.json`);
      }
    }
  }
  return files.filter((f) => !isExcluded(excludeSet, f));
}

/** ground/par map-note tags are two separate name pools sharing a bare
 *  numeric id ("<ground:75>" and "<par:75>" are different files), and an
 *  unbaked note stores just that bare number; the pool name is only implied
 *  by the tag. Reconstruct the real stem ("ground75") so existence-checking
 *  and reporting target the actual asset instead of colliding the two pools
 *  under the same bare value. Left untouched when the value is already the
 *  on-disk hash, or already carries its pool prefix (a baked project's note
 *  already reads e.g. "ground75"). */
function resolveNoteValue(value, tag) {
  if (!tag || isHashLike(value) || value.toLowerCase().startsWith(tag)) {
    return value;
  }
  return tag + value;
}

/** Record that `logical` referenced this asset, via `literalRef`; the exact
 *  source text (event-command parameters array, "field: value", or note tag;
 *  see transformDoc's `meta.kind` in map-names.js); if known. referencedBy
 *  is file -> Set<literalRef>, so a reference can be traced back to exactly
 *  how it appears, not just which file it's in. */
function addReference(ref, logical, literalRef) {
  let refs = ref.referencedBy.get(logical);
  if (!refs) {
    refs = new Set();
    ref.referencedBy.set(logical, refs);
  }
  if (literalRef) refs.add(literalRef);
}

/** Collect every non-empty {dir, value} asset reference across the effective
 *  data set, deduped, with the file(s)/kind(s) that mentioned each one. The
 *  raw faceName/characterName value is kept as-is (no [BUST] guess applied
 *  here); real mod files are inconsistent about that tag (see below), so
 *  resolving it is deferred to existence-check time, where several on-disk
 *  spellings can be tried. */
function collectRefs(modRoot, baseRoot, excludeSet) {
  const refs = new Map(); // "dir value" -> { dir, value, referencedBy: Map<file, Set<literalRef>> }

  for (const logical of listDataFiles(modRoot, baseRoot, excludeSet)) {
    const doc = loadEffectiveJson(modRoot, baseRoot, logical);
    if (doc === null) continue;

    transformDoc(doc, (dir, value, meta) => {
      if (typeof value === "string" && value) {
        const resolved = resolveNoteValue(value, meta && meta.tag);
        const key = dir + " " + resolved;
        let ref = refs.get(key);
        if (!ref) {
          ref = { dir, value: resolved, referencedBy: new Map() };
          refs.set(key, ref);
        }
        addReference(ref, logical, meta && meta.kind);
      }
      return value; // read-only: transformDoc is used purely as a walker here
    });
  }

  return [...refs.values()];
}

// img/faces carries a trailing bust-image tag baked into the on-disk hash
// (the Irina VN-bust plugin convention; see hashPath's own special-casing in
// build-tomb-mod.js for the canonical bracketed form). But real, hand-authored
// mod folders are not consistent about it: some faces have no bust variant at
// all (e.g. "dt_ohshit.png"), some use the canonical "[BUST]" bracket, and
// some just tack on "BUST" or "_BUST" with no brackets at all (e.g.
// "d_LookingAwayBUST.png", "d_mad_EyesClose_BUST.png"). All of these need to
// be tried when checking existence; only the non-bracketed ones are flagged
// as non-standard.
const BUST_TAG = "[BUST]";
const BUST_DETECT_ORDER = [BUST_TAG, "_BUST", "BUST"]; // longest/most specific first
const BUST_APPEND_CANDIDATES = ["", BUST_TAG, "BUST", "_BUST"]; // "" = no bust variant at all

function isBustDir(dir) {
  return dirSuffix(dir) === BUST_TAG;
}

/** The bust tag already present at the end of `value`, or null. Checked
 *  longest-first so "..._BUST" isn't misread as the bare "BUST" form. */
function detectBustTag(value) {
  const upper = value.toUpperCase();
  for (const tag of BUST_DETECT_ORDER) {
    if (upper.endsWith(tag)) return tag;
  }
  return null;
}

/** A resolved bust tag counts as non-standard when it's a bust image but not
 *  spelled with the canonical brackets. */
function isWeirdBustTag(tag) {
  return tag === "BUST" || tag === "_BUST";
}

/** On-disk stems to try for a bust-dir reference, paired with the tag that
 *  produced each. If `value` already ends in a recognized tag, it's used
 *  verbatim (single candidate) rather than appending another one on top. */
function bustStemCandidates(value) {
  const existing = detectBustTag(value);
  if (existing) return [{ stem: value, tag: existing }];
  return BUST_APPEND_CANDIDATES.map((tag) => ({ stem: value + tag, tag }));
}

/** Try to resolve a reference to a real file under `root`. Returns
 *  { stem, tag } for whichever candidate matched, or null if none did. `tag`
 *  is null for non-bust dirs and already-hashed values, "" for a bust-dir
 *  match with no bust variant, "[BUST]" for the canonical form, or
 *  "BUST"/"_BUST" for a non-standard match (see isWeirdBustTag). */
function resolveMatch(root, dir, value) {
  if (isHashLike(value)) {
    return isFile(path.join(root, dir, value)) ? { stem: value, tag: null } : null;
  }
  if (!isBustDir(dir)) {
    const logical = `${dir}/${value}${dirExt(dir)}`;
    return resolveBaseBytes(root, logical) !== null ? { stem: value, tag: null } : null;
  }
  for (const cand of bustStemCandidates(value)) {
    const logical = `${dir}/${cand.stem}${dirExt(dir)}`;
    if (resolveBaseBytes(root, logical) !== null) return cand;
  }
  return null;
}

const byDirThenValue = (a, b) =>
  a.dir === b.dir ? a.value.localeCompare(b.value) : a.dir.localeCompare(b.dir);

/** Split refs into "missing" (resolves nowhere, in mod or base) and "weird"
 *  (resolves, but only via a non-standard bust tag; worth a nudge to rename,
 *  not a real miss). */
function classifyRefs(modRoot, baseRoot, refs) {
  const missing = [];
  const weird = [];

  for (const ref of refs) {
    const match =
      resolveMatch(modRoot, ref.dir, ref.value) ||
      resolveMatch(baseRoot, ref.dir, ref.value);
    if (!match) {
      missing.push(ref);
    } else if (isWeirdBustTag(match.tag)) {
      weird.push({ ...ref, matchedStem: match.stem, matchedTag: match.tag });
    }
  }

  missing.sort(byDirThenValue);
  weird.sort(byDirThenValue);
  return { missing, weird };
}

/** "dir/value.ext" for the missing-report: a bust dir with no tag already on
 *  the value gets the canonical "[BUST]" guessed on (the best hint for what
 *  the base game convention expects), or "dir/value" verbatim when value is
 *  already the on-disk hashed basename. */
function logicalDisplay(dir, value) {
  if (isHashLike(value)) return `${dir}/${value}`;
  const stem = isBustDir(dir) && !detectBustTag(value) ? value + BUST_TAG : value;
  return `${dir}/${stem}${dirExt(dir)}`;
}

/** On-disk hashed basename a human-readable reference would resolve to (same
 *  canonical-guess rule as logicalDisplay), or null when the value already is
 *  one (nothing further to hash). */
function hashedBasename(dir, value) {
  if (isHashLike(value)) return null;
  const stem = isBustDir(dir) && !detectBustTag(value) ? value + BUST_TAG : value;
  return hashPath(`${dir}/${stem}${dirExt(dir)}`).split("/").pop();
}

/** "data/Map012.json" -> "Map012"; just enough to identify the data file in
 *  the compact one-line report. */
function shortDataName(logical) {
  return logical.replace(/^data\//, "").replace(/\.json$/, "");
}

/** Just the file names, for the missing-assets report; breadth over detail. */
function referencedByList(referencedBy) {
  return [...referencedBy.keys()].map(shortDataName).sort().join(", ");
}

/** "File: <literal reference>" per occurrence, for the weird-format report -
 *  the exact parameters array / field assignment / note tag the value came
 *  from (see transformDoc's `meta.kind` in map-names.js), not just which
 *  file. */
function referencedByDetail(referencedBy) {
  const parts = [];
  for (const [file, refs] of referencedBy) {
    const shortFile = shortDataName(file);
    if (refs.size === 0) {
      parts.push(shortFile);
      continue;
    }
    for (const ref of refs) parts.push(`${shortFile}: ${ref}`);
  }
  return parts.sort().join(", ");
}

function referencedByJson(referencedBy) {
  return [...referencedBy.entries()]
    .map(([file, refs]) => ({ file, refs: [...refs].sort() }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

/** Print rows of equal-length string arrays as aligned columns (each column
 *  padded to its widest cell; the last column is left ragged to avoid
 *  trailing whitespace). */
function printTable(rows) {
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] || 0, cell.length);
    });
  }
  for (const row of rows) {
    console.log(
      row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]))).join("  "),
    );
  }
}

function missingRow(m) {
  const logical = logicalDisplay(m.dir, m.value);
  const hash = hashedBasename(m.dir, m.value);
  return [logical, hash ? `[${hash}]` : "", `(${referencedByList(m.referencedBy)})`];
}

function weirdRow(w) {
  const logical = `${w.dir}/${w.matchedStem}${dirExt(w.dir)}`;
  return [logical, `[weird bust tag: ${w.matchedTag}]`, `(${referencedByDetail(w.referencedBy)})`];
}

function report(missing, weird, json) {
  if (json) {
    console.log(
      JSON.stringify(
        {
          missing: missing.map((m) => ({
            dir: m.dir,
            value: m.value,
            logical: logicalDisplay(m.dir, m.value),
            hash: hashedBasename(m.dir, m.value),
            referencedBy: referencedByJson(m.referencedBy),
          })),
          weird: weird.map((w) => ({
            dir: w.dir,
            value: w.value,
            matchedStem: w.matchedStem,
            matchedTag: w.matchedTag,
            logical: `${w.dir}/${w.matchedStem}${dirExt(w.dir)}`,
            referencedBy: referencedByJson(w.referencedBy),
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (missing.length === 0 && weird.length === 0) {
    console.log("No issues found: every referenced asset resolves in the mod or base game.");
    return;
  }

  if (missing.length > 0) {
    printTable(missing.map(missingRow));
    console.log(`\n${missing.length} missing asset(s).`);
  } else {
    console.log("No missing assets.");
  }

  if (weird.length > 0) {
    console.log(`\nNon-standard bust naming (found, but not the canonical "${BUST_TAG}" form):`);
    printTable(weird.map(weirdRow));
    console.log(`\n${weird.length} weird-format asset(s).`);
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.mod || !opts.base) usage();

  if (!isDir(opts.mod)) {
    console.error(`error: --mod not found: ${opts.mod}`);
    process.exit(1);
  }
  if (!isDir(opts.base)) {
    console.error(`error: --base not found: ${opts.base}`);
    process.exit(1);
  }

  const modRoot = contentRoot(opts.mod);
  const baseRoot = contentRoot(opts.base);
  const excludeSet = buildExcludeSet(opts.exclude);

  const refs = collectRefs(modRoot, baseRoot, excludeSet);
  const { missing, weird } = classifyRefs(modRoot, baseRoot, refs);

  report(missing, weird, opts.json);
  process.exit(missing.length > 0 || weird.length > 0 ? 1 : 0);
}

main();
