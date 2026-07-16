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
 * generate-dl-pages.js
 *
 * Writes one download-tracking page per mods.json entry to <outDir>/dl/<id>.html.
 *
 * These pages exist purely so Cloudflare Web Analytics reports a per-mod
 * download count: lang-shim.js loads /dl/{id}.html in a hidden iframe after a
 * user-initiated install, and the "top pages" report then counts one view per
 * download. Nothing reads the page content.
 *
 * The pages carry no script of their own. With Web Analytics on "automatic
 * setup" Cloudflare injects the beacon into HTML responses at the edge, which
 * is also why the markup must stay valid: invalid HTML is not injected into.
 *
 * Build output only, never committed: deploy-web.yml runs this against the
 * mods.json already staged in _site, so the page set cannot drift from the mod
 * list the app actually reads.
 *
 * Usage: node tools/generate-dl-pages.js <outDir>
 */

"use strict";

var fs = require("fs");
var path = require("path");

// Tools live in tools/; project root is one level up.
var ROOT = path.join(__dirname, "..");

// Mod ids become filenames under dl/. Anything outside this set could escape
// the directory (path separators, "..") or land on a name the static host
// cannot serve, so a violation is a build error rather than a silent skip.
var SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** Minimal HTML escape for text interpolated into the page. */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The tracking page for one mod. Valid, minimal, and noindex: it is a
 * counter, not content, and must never surface in search results.
 */
function renderPage(modId, modName) {
  var title = escapeHtml(modName || modId);
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="robots" content="noindex, nofollow">',
    "<title>" + title + "</title>",
    "</head>",
    "<body>",
    "<p>" + title + "</p>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function main() {
  var outDir = process.argv[2];
  if (!outDir) {
    console.error("Usage: node tools/generate-dl-pages.js <outDir>");
    process.exit(1);
  }

  // Prefer the mods.json staged in the output dir (what the deploy actually
  // ships) and fall back to the repo copy for local runs.
  var staged = path.join(outDir, "mods.json");
  var modsJson = fs.existsSync(staged) ? staged : path.join(ROOT, "mods.json");

  var mods = JSON.parse(fs.readFileSync(modsJson, "utf8"));
  var ids = Object.keys(mods);

  var bad = ids.filter(function (id) {
    return !SAFE_ID.test(id);
  });
  if (bad.length) {
    console.error("Unsafe mod id(s) for use as a filename: " + bad.join(", "));
    process.exit(1);
  }

  var dlDir = path.join(outDir, "dl");
  fs.mkdirSync(dlDir, { recursive: true });

  ids.forEach(function (id) {
    var entry = mods[id] || {};
    fs.writeFileSync(
      path.join(dlDir, id + ".html"),
      renderPage(id, entry.name),
      "utf8",
    );
  });

  console.log(
    "Wrote " +
      ids.length +
      " download-tracking page(s) to " +
      dlDir +
      " (from " +
      path.relative(ROOT, modsJson) +
      ")",
  );
}

main();
