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
 * map-names.js: recover human map names for a remaster extract by content match.
 *
 * The remaster blanks MapInfos[].name and hashes filenames irreversibly, so a
 * map's real name can't be read or hashed back. But an older build still ships
 * named maps, and a map's *content* survives the remaster: its events reference
 * a stable, scene-specific set of localization placeholder codes
 * ((lines)[CODE] / (label)[CODE]). Those code sets are an effective fingerprint
 * overlap them (Jaccard) and the blank current map inherits the name of the
 * old map it shares the most codes with.
 *
 * Why codes and not the tile `data` array: TCOAAL parallax-maps everything, so
 * the `data` layer is mostly empty and dozens of unrelated maps look ~99%
 * identical. The placeholder codes, by contrast, separate scenes cleanly (a
 * confident match clears its runner-up by a wide margin: see THRESHOLDS).
 *
 * The reference is bundled as map-name-keys.json (built by
 * build-map-name-keys.js from a named-maps game) so extraction names maps with
 * no extra input; --names-from rebuilds it live from any named-maps build.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { hashPath, dekit, decodeK9a } = require("./build-tomb-mod.js");

// =====================================================================
// Asset-filename round-trip (formerly file-names.js)
// =====================================================================
//
// Asset filenames recovered from the last unencrypted TCOAAL build (before the
// "Cry About It" remaster), grouped by the directory the assets live in, loaded
// from map-filenames.json.
//
// The remaster stores every asset under hashPath(<logical name>) and references
// it in the data by that same hash, so the current on-disk hash for a name is
// DERIVED here via hashPath(dir + "/" + name + ext): that is authoritative and
// matches the shipped files. (Earlier dumps shipped a literal hash column that
// had transcription errors; we no longer rely on it.)
//
// Used by extract-project.js to make these hashes readable in RPG Maker MV
// (hash -> name on extract) and by pack-project.js to restore them (name -> the
// exact original hash on pack), the same round-trip the localized dialogue text
// gets (see lang-roundtrip.js). img/system and data files are intentionally NOT
// here: extract-project recovers those through its own hard-coded engine-name
// sets (their remaster hashing differs).

// require() (not fs.readFileSync) so esbuild inlines the JSON into the browser
// bundle; Node resolves it identically.
const ASSET_NAMES = require("./map-filenames.json");

// img assets are PNG, audio is OGG in TCOAAL.
function dirExt(dir) {
  return dir.indexOf("audio/") === 0 ? ".ogg" : ".png";
}
// img/faces are stored with a trailing "[BUST]" tag (the Irina VN-bust plugin
// convention); hashPath appends it to the hash too, so it is part of the stem.
function dirSuffix(dir) {
  return dir === "img/faces" ? "[BUST]" : "";
}

// Lazily build, per directory, the two lookups the round-trip needs:
//   hashToStem: on-disk hash basename  -> editor stem (extract / bake)
//   stemToHash: editor stem            -> on-disk hash basename (pack / unbake)
// The stem is the human name plus any directory suffix (e.g. "b_happy[BUST]"),
// and is exactly what the renamed file is called and what the data references.
let _maps = null;
function maps() {
  if (_maps) return _maps;
  _maps = {};
  for (const dir of Object.keys(ASSET_NAMES)) {
    const ext = dirExt(dir);
    const suffix = dirSuffix(dir);
    const hashToStem = new Map();
    const stemToHash = new Map();
    for (const name of ASSET_NAMES[dir]) {
      const stem = name + suffix;
      const basename = hashPath(dir + "/" + stem + ext)
        .split("/")
        .pop();
      // First name wins on the rare duplicate (the same logical file listed
      // twice in old dumps), so the mapping stays one-to-one and reversible.
      if (!hashToStem.has(basename)) hashToStem.set(basename, stem);
      if (!stemToHash.has(stem)) stemToHash.set(stem, basename);
    }
    _maps[dir] = { hashToStem, stemToHash };
  }
  return _maps;
}

// A bare storage name (16 hex, optional "!" prefix / "[BUST]" suffix): already
// in on-disk form, so the unbaker leaves it untouched.
const HASH_RE = /^!?[0-9a-f]{16}(\[BUST\])?$/i;

// Public predicate: is this asset-reference value already an on-disk hashed
// basename (as opposed to a human-readable stem)? Used by check-mod-assets.js
// to decide whether to look the value up verbatim or hash it first.
function isHashLike(value) {
  return typeof value === "string" && HASH_RE.test(value);
}

// Value transforms. Both are gated to the known name table: anything not in it
// (a remaster-only asset still on its hash, or a name a modder freely authored)
// passes through unchanged and still resolves at runtime via hashPath.
function toName(dir, value) {
  if (typeof value !== "string" || !value) return value;
  const m = maps()[dir];
  if (!m) return value;
  return m.hashToStem.get(value) || value;
}
function toHash(dir, value) {
  if (typeof value !== "string" || !value) return value;
  if (HASH_RE.test(value)) return value;
  const m = maps()[dir];
  if (!m) return value;
  return m.stemToHash.get(value) || value;
}

// Rewrite the <ground:..> / <par:..> overlay tags inside a map note (drawn by
// the OrangeOverlay plugin from img/parallaxes). Only the captured value is
// transformed; the rest of the note is preserved verbatim.
// A { kind, tag } meta object is passed as a 3rd argument so callers that
// need it can disambiguate and quote the reference verbatim. `kind` is the
// literal source text (the event command's full parameters array, the
// "field: value" the value came from, or the matched note tag); not a
// friendly label; so check-mod-assets.js can show exactly how an asset is
// referenced. `tag` ("ground"/"par") lets it resolve a note's bare numeric
// value: ground and par are separate name pools, and an unbaked note stores
// just the bare number with the pool name only implied by the tag, e.g.
// <ground:75> really means img/parallaxes/ground75.png. toName/toHash (2-arg
// signatures) simply ignore this argument: they already recover the full
// "ground75" stem from the hash itself.
function transformNote(note, fn) {
  if (typeof note !== "string" || !note) return note;
  return note.replace(/<(ground|par):([^>]+)>/g, (full, tag, val) => {
    const next = fn("img/parallaxes", val.trim(), { kind: full, tag });
    return next === val.trim() ? full : "<" + tag + ":" + next + ">";
  });
}

// OrangeOverlay_AlteredByChancer's runtime plugin-command syntax (as opposed to
// the map-note tags above): a code-356 "Plugin Command" event whose single
// parameters[0] string is "Overlay <type> <filename> ...", e.g.
// "Overlay ground ground88" or "Overlay fog fog1 100 10 0 0 20". All layer
// types resolve to img/parallaxes here (never img/overlays/<type>s) because
// this game ships OrangeOverlay with "Organized Folders": "false", so
// Spriteset_Map.prototype.loadBitmap falls back to ImageManager.loadParallax
// regardless of layer type. "fadeout"/"removefog" reference no file and are
// not matched.
const OVERLAY_CMD_RE =
  /^(overlay)(\s+)(ground|par|light|shadow|addfog|fog)(\s+)(\S+)/i;
function transformOverlayCommand(text, fn) {
  if (typeof text !== "string" || !text) return text;
  return text.replace(OVERLAY_CMD_RE, (full, cmd, sp1, type, sp2, value) => {
    const next = fn("img/parallaxes", value, { kind: JSON.stringify([text]) });
    return next === value ? full : cmd + sp1 + type + sp2 + next;
  });
}

// RPG Maker MV event-command asset references, by command code. Each entry says
// which positional parameter holds the reference and which directory it targets;
// "audio" means the parameter is an {name,volume,pitch,pan} object.
const COMMAND_REFS = {
  101: [{ index: 0, dir: "img/faces", param: "faceName" }],
  231: [{ index: 1, dir: "img/pictures", param: "pictureName" }],
  241: [{ index: 0, dir: "audio/bgm", audio: true, param: "bgm" }],
  132: [{ index: 0, dir: "audio/bgm", audio: true, param: "bgm" }],
  140: [{ index: 1, dir: "audio/bgm", audio: true, param: "bgm" }],
  245: [{ index: 0, dir: "audio/bgs", audio: true, param: "bgs" }],
  249: [{ index: 0, dir: "audio/me", audio: true, param: "me" }],
  133: [{ index: 0, dir: "audio/me", audio: true, param: "me" }],
  139: [{ index: 0, dir: "audio/me", audio: true, param: "me" }],
  250: [{ index: 0, dir: "audio/se", audio: true, param: "se" }],
  284: [{ index: 0, dir: "img/parallaxes", param: "parallaxName" }],
  // Game_Interpreter.command322: actor.setCharacterImage(params[1], params[2])
  // then actor.setFaceImage(params[3], params[4]); index 1 is the character
  // sprite, index 3 is the face.
  322: [
    { index: 1, dir: "img/characters", param: "characterName" },
    { index: 3, dir: "img/faces", param: "faceName" },
  ],
  323: [{ index: 1, dir: "img/characters", param: "characterName" }],
};

// Object property names whose value is an asset reference, by directory.
const IMAGE_FIELDS = {
  characterName: "img/characters",
  faceName: "img/faces",
  parallaxName: "img/parallaxes",
  title1Name: "img/titles1",
  title2Name: "img/titles1",
};
// Object property names whose value is an audio object ({name,volume,...}).
const AUDIO_FIELDS = {
  bgm: "audio/bgm",
  battleBgm: "audio/bgm",
  titleBgm: "audio/bgm",
  bgs: "audio/bgs",
  me: "audio/me",
  victoryMe: "audio/me",
  defeatMe: "audio/me",
  gameoverMe: "audio/me",
  se: "audio/se",
};

function isAudio(o) {
  return (
    o &&
    typeof o === "object" &&
    typeof o.name === "string" &&
    typeof o.volume === "number"
  );
}

// Walk a data document and apply `fn(dir, value) -> value` to every asset
// reference: event-command parameters, the standard image/audio fields, the
// System.sounds[] SE list, Tileset.tilesetNames[], and map-note overlay tags.
// Field-typed, so it only ever touches genuine asset references (never logic
// strings) and always knows the directory (so collisions like "buzz" in both
// bgm and bgs stay unambiguous).
function transformDoc(doc, fn) {
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const v of node) visit(v);
      return;
    }
    if (!node || typeof node !== "object") return;

    if (typeof node.code === "number" && Array.isArray(node.parameters)) {
      if (node.code === 356 && typeof node.parameters[0] === "string") {
        node.parameters[0] = transformOverlayCommand(node.parameters[0], fn);
      }
      const specs = COMMAND_REFS[node.code];
      if (specs) {
        // The literal parameters array, exactly as it appears in the Map
        // file; not a friendly label; so a caller can show the reference
        // verbatim (e.g. check-mod-assets.js's weird-format report).
        const raw = JSON.stringify(node.parameters);
        for (const s of specs) {
          const p = node.parameters[s.index];
          const meta = { kind: raw };
          if (s.audio) {
            if (isAudio(p)) p.name = fn(s.dir, p.name, meta);
          } else if (typeof p === "string") {
            node.parameters[s.index] = fn(s.dir, p, meta);
          }
        }
      }
    }

    for (const field of Object.keys(IMAGE_FIELDS)) {
      if (typeof node[field] === "string") {
        const raw = `${field}: ${JSON.stringify(node[field])}`;
        node[field] = fn(IMAGE_FIELDS[field], node[field], { kind: raw });
      }
    }
    for (const field of Object.keys(AUDIO_FIELDS)) {
      if (isAudio(node[field])) {
        const raw = `${field}: ${JSON.stringify(node[field])}`;
        node[field].name = fn(AUDIO_FIELDS[field], node[field].name, { kind: raw });
      }
    }
    if (Array.isArray(node.sounds)) {
      for (const s of node.sounds) {
        if (isAudio(s)) s.name = fn("audio/se", s.name, { kind: `sounds: ${JSON.stringify(s)}` });
      }
    }
    if (Array.isArray(node.tilesetNames)) {
      const raw = `tilesetNames: ${JSON.stringify(node.tilesetNames)}`;
      node.tilesetNames = node.tilesetNames.map((n) =>
        typeof n === "string" ? fn("img/tilesets", n, { kind: raw }) : n,
      );
    }
    if (typeof node.note === "string") node.note = transformNote(node.note, fn);

    for (const k of Object.keys(node)) visit(node[k]);
  };
  visit(doc);
}

// Public round-trip entry points.
function bakeAssetNames(doc) {
  transformDoc(doc, toName);
}
function unbakeAssetNames(doc) {
  transformDoc(doc, toHash);
}

// Reverse of extract-project's setMapBackground. extract points an otherwise
// empty parallaxName at an editor-only composite ("bg_<ground>_<par>", or a
// single <ground>/<par> layer) so the editor map view shows the background. The
// shipped game keeps parallaxName "" and draws the background from the map note
// via the OrangeOverlay plugin, so packing back MUST clear that synthetic name,
// otherwise the engine requests img/parallaxes/bg_<ground>_<par> at run time and
// 404s (the composite is never shipped).
//
// Only clears when parallaxName is EXACTLY the value extract would have minted
// from this same map's note (so an author-set parallax is left untouched), and
// must run BEFORE unbakeAssetNames (which rewrites the note's <ground>/<par> back
// to hashes) so the note values still match the human-named parallaxName.
function unbakeMapBackground(map) {
  if (!map || typeof map.parallaxName !== "string" || !map.parallaxName) return;
  if (typeof map.note !== "string" || !map.note) return;
  const ground = (map.note.match(/<ground:([^>]+)>/) || [])[1];
  const par = (map.note.match(/<par:([^>]+)>/) || [])[1];
  if (!ground && !par) return;
  const g = ground ? ground.trim() : "";
  const p = par ? par.trim() : "";
  const synthetic = g && p ? `bg_${g}_${p}` : g || p;
  if (map.parallaxName === synthetic) {
    map.parallaxName = "";
    // The remaining parallax* fields are inert once the name is empty (MV draws
    // no parallax without a name), so leaving them is harmless and keeps the
    // diff minimal.
  }
}

// For extract-project's file walk: given an on-disk relative path
// (e.g. "img/faces/e916...[BUST]"), return { dir, stem } when the asset has a
// known name, else null. The caller appends the extension.
function lookupRename(rel) {
  const idx = rel.lastIndexOf("/");
  if (idx < 0) return null;
  const dir = rel.slice(0, idx);
  const basename = rel.slice(idx + 1);
  const m = maps()[dir];
  if (!m) return null;
  const stem = m.hashToStem.get(basename);
  return stem ? { dir, stem } : null;
}

// Acceptance thresholds, calibrated against test/c (65 named maps) vs the
// current remaster: confident matches score >= 0.5 and clear their runner-up by
// >= 0.15 (observed min margin 0.52); maps with too few codes carry no reliable
// signature and are left as MapNNN.
const MIN_KEYS = 3; // a current map needs at least this many codes to match
const THRESHOLD = 0.5; // minimum Jaccard overlap to accept
const MARGIN = 0.15; // best must beat the runner-up by at least this much

/** Decode a logical data file from any game layout (old .k9a, remaster
 *  hashed+TCOAAL, or a plain dump), returning plaintext bytes or null. .k9a is
 *  tried first because some builds ship both a clean .k9a and a hashed copy. */
function decodeLogical(www, logical) {
  const k9a = path.join(www, logical.replace(/\.[^./]+$/, ".k9a"));
  if (fs.existsSync(k9a)) return decodeK9a(fs.readFileSync(k9a), logical);

  const hp = hashPath(logical);
  const hashed = path.join(www, hp);
  if (fs.existsSync(hashed)) return dekit(fs.readFileSync(hashed), hp);

  const plain = path.join(www, logical);
  if (fs.existsSync(plain)) return fs.readFileSync(plain);

  return null;
}

/** Extract the set of bare localization placeholder codes referenced by a map's
 *  JSON text. `(lines)[Wb5LCdMV]` / `(label)[x86GCl9v]` -> "Wb5LCdMV" etc. The
 *  bare code is enough to be unique across scenes; (lines) vs (label) needn't be
 *  distinguished as long as both sides are extracted the same way. */
function mapKeyCodes(str) {
  const set = new Set();
  const re = /\((?:lines|label)\)\[([^\]]+)\]/g;
  let m;
  while ((m = re.exec(str))) set.add(m[1]);
  return set;
}

/** Jaccard overlap of two code sets (0 when either is empty). */
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Load the named-map reference: an array of { name, keys:Set<code> }.
 *  With `namesFrom` (a path to a named-maps game), build it live from that
 *  build's MapInfos; otherwise load the bundled map-name-keys.json. Returns
 *  null if no reference is available. */
function loadMapNameRefs(namesFrom) {
  if (namesFrom) {
    let www = namesFrom;
    if (!fs.existsSync(path.join(www, "data"))) {
      const inner = path.join(www, "www");
      if (fs.existsSync(path.join(inner, "data"))) www = inner;
    }
    const infosBuf = decodeLogical(www, "data/MapInfos.json");
    if (!infosBuf) return null;
    const infos = JSON.parse(infosBuf.toString("utf8"));
    const refs = [];
    for (const e of infos) {
      if (!e || !e.name) continue;
      const buf = decodeLogical(
        www,
        `data/Map${String(e.id).padStart(3, "0")}.json`,
      );
      if (!buf) continue;
      const keys = mapKeyCodes(buf.toString("utf8"));
      if (keys.size) refs.push({ name: e.name, keys });
    }
    return refs.length ? refs : null;
  }

  // require() so esbuild inlines the (large) reference into the browser bundle.
  const raw = require("./map-name-keys.json");
  return raw.map((m) => ({ name: m.n, keys: new Set(m.k) }));
}

/** Resolve canonical map names for the game at `www` by matching each map's
 *  placeholder-code set against the reference. Returns Map<id, name> holding
 *  only confident matches; ambiguous / signature-less maps are omitted (and
 *  fall back to MapNNN at the call site). */
function resolveMapNames(www, refs) {
  const out = new Map();
  if (!refs || !refs.length) return out;

  const infosBuf = decodeLogical(www, "data/MapInfos.json");
  if (!infosBuf) return out;
  let infos;
  try {
    infos = JSON.parse(infosBuf.toString("utf8"));
  } catch (_) {
    return out;
  }

  for (const e of infos) {
    if (!e || !e.id) continue;
    const buf = decodeLogical(
      www,
      `data/Map${String(e.id).padStart(3, "0")}.json`,
    );
    if (!buf) continue;
    const codes = mapKeyCodes(buf.toString("utf8"));
    if (codes.size < MIN_KEYS) continue;

    let best = null;
    let bestScore = -1;
    let secondScore = -1;
    for (const ref of refs) {
      const sc = jaccard(codes, ref.keys);
      if (sc > bestScore) {
        secondScore = bestScore;
        bestScore = sc;
        best = ref;
      } else if (sc > secondScore) {
        secondScore = sc;
      }
    }

    if (best && bestScore >= THRESHOLD && bestScore - secondScore >= MARGIN) {
      out.set(e.id, best.name);
    }
  }

  return out;
}

module.exports = {
  MIN_KEYS,
  THRESHOLD,
  MARGIN,
  decodeLogical,
  mapKeyCodes,
  jaccard,
  loadMapNameRefs,
  resolveMapNames,
  // asset-filename round-trip (formerly file-names.js)
  ASSET_NAMES,
  dirExt,
  dirSuffix,
  toName,
  toHash,
  isHashLike,
  transformDoc,
  bakeAssetNames,
  unbakeAssetNames,
  unbakeMapBackground,
  lookupRename,
};
