// Build src/data/places.json: the towns and postal districts the place search
// can fly to (placeindex.ts). Adressevælgeren, the address service, knows
// streets and house numbers only -- no towns, no postal districts -- so these
// come from the same public registers it is built on, via Datafordeler:
//
//   - Danske Stednavne, sn:Bebyggelse of type by, bydel and sommerhusområde
//     (towns and villages, parts of towns, holiday-home areas): name, a point
//     inside it and its size;
//   - DAGI, dagi10:Postnummerinddeling: every postal district's number, name
//     and extent, and which district each town lies in.
//
// Both answer the web app's own Datafordeler API-Key (VITE_DATAFORDELER_API_KEY,
// a public key that ships in the client anyway). Danske Stednavne has been
// frozen since 2025-09 and postal districts change a few times a year, so this
// is run by hand, not in the weekly pipeline:
//
//   node scripts/gen-places.mjs            (reads the key from .env.local)

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "..", "src", "data", "places.json");

function apiKey() {
  if (process.env.VITE_DATAFORDELER_API_KEY) return process.env.VITE_DATAFORDELER_API_KEY;
  const env = fs.readFileSync(path.join(here, "..", ".env.local"), "utf8");
  const match = /^VITE_DATAFORDELER_API_KEY=(.+)$/m.exec(env);
  if (!match) throw new Error("VITE_DATAFORDELER_API_KEY not set");
  return match[1].trim();
}
const KEY = apiKey();

const STEDNAVNE = "https://wfs.datafordeler.dk/Stednavn/STEDNAVNE_BEARBEJDET_GML3SFP/1/WFS";
const DAGI = "https://wfs.datafordeler.dk/DAGIM/DAGI_10MULTIGEOM_GMLSFP/1.0.0/WFS";
const TOWN_TYPES = ["by", "bydel", "sommerhusområde"];

async function wfsPages(base, params, pageSize) {
  const pages = [];
  for (let start = 0; ; start += pageSize) {
    const query = new URLSearchParams({
      service: "WFS",
      version: "2.0.0",
      request: "GetFeature",
      count: String(pageSize),
      startIndex: String(start),
      ...params,
    });
    const url = `${base}?${query}&apikey=${encodeURIComponent(KEY)}`;
    let text = null;
    for (let attempt = 0; attempt < 3 && text === null; attempt++) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        text = await res.text();
      } catch (err) {
        console.error(`  page ${start} attempt ${attempt + 1}: ${err.message}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (text === null) throw new Error(`could not fetch ${params.typeNames} from ${start}`);
    const members = text.split("<wfs:member>").slice(1);
    pages.push(...members);
    process.stdout.write(`  ${params.typeNames}: ${pages.length}\r`);
    if (members.length < pageSize) break;
  }
  process.stdout.write("\n");
  return pages;
}

const field = (member, name) => {
  const m = new RegExp(`<[a-z0-9]+:${name.replace(".", "\\.")}[^>]*>([^<]*)<`).exec(member);
  return m ? m[1].trim() : null;
};

/** Every exterior ring of a member, as flat [x, y, x, y, ...] in EPSG:25832. */
function rings(member) {
  const out = [];
  const re = /<gml:exterior>[\s\S]*?<gml:posList[^>]*>([^<]*)<\/gml:posList>/g;
  for (let m; (m = re.exec(member));) out.push(m[1].trim().split(/\s+/).map(Number));
  return out;
}

function ringArea(r) {
  let sum = 0;
  for (let i = 0; i + 3 < r.length; i += 2) sum += r[i] * r[i + 3] - r[i + 2] * r[i + 1];
  return sum / 2;
}

function ringCentroid(r) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i + 3 < r.length; i += 2) {
    const f = r[i] * r[i + 3] - r[i + 2] * r[i + 1];
    a += f;
    cx += (r[i] + r[i + 2]) * f;
    cy += (r[i + 1] + r[i + 3]) * f;
  }
  if (a === 0) return [r[0], r[1]];
  return [cx / (3 * a), cy / (3 * a)];
}

function inRing(x, y, r) {
  let inside = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i];
    const yi = r[i + 1];
    const xj = r[j];
    const yj = r[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// EPSG:25832 -> WGS84 (as web/src/addresses.ts)
function utm32nToWgs84(x, y) {
  const a = 6378137.0;
  const f = 1 / 298.257223563;
  const k0 = 0.9996;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const mu = y / k0 / (a * (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const n1 = a / Math.sqrt(1 - e2 * Math.sin(phi1) ** 2);
  const t1 = Math.tan(phi1) ** 2;
  const c1 = ep2 * Math.cos(phi1) ** 2;
  const r1 = (a * (1 - e2)) / (1 - e2 * Math.sin(phi1) ** 2) ** 1.5;
  const d = (x - 500000) / (n1 * k0);
  const lat =
    phi1 -
    ((n1 * Math.tan(phi1)) / r1) *
      (d ** 2 / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep2) * d ** 4) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep2 - 3 * c1 ** 2) * d ** 6) / 720);
  const lon =
    (9 * Math.PI) / 180 +
    (d -
      ((1 + 2 * t1 + c1) * d ** 3) / 6 +
      ((5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ep2 + 24 * t1 ** 2) * d ** 5) / 120) /
      Math.cos(phi1);
  return [(lon * 180) / Math.PI, (lat * 180) / Math.PI];
}

const r3 = (v) => Math.round(v * 1e3) / 1e3;

console.log("postal districts (DAGI)…");
const postalMembers = await wfsPages(DAGI, { typeNames: "dagi10:Postnummerinddeling" }, 100);
const postal = [];
for (const member of postalMembers) {
  const postnr = field(member, "postnummer");
  const name = field(member, "navn");
  const rs = rings(member);
  if (!postnr || !name || rs.length === 0) continue;
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const r of rs) {
    for (let i = 0; i < r.length; i += 2) {
      w = Math.min(w, r[i]);
      e = Math.max(e, r[i]);
      s = Math.min(s, r[i + 1]);
      n = Math.max(n, r[i + 1]);
    }
  }
  postal.push({
    postnr,
    name,
    rings: rs,
    box: [w, s, e, n],
    street: field(member, "erGadepostnummer") === "true",
  });
}
postal.sort((a, b) => a.postnr.localeCompare(b.postnr));
console.log(`  ${postal.length} districts`);

function districtAt(x, y) {
  // a street postcode (Copenhagen) is a few streets: prefer the ordinary district
  let fallback = -1;
  for (let i = 0; i < postal.length; i++) {
    const p = postal[i];
    const [w, s, e, n] = p.box;
    if (x < w || x > e || y < s || y > n) continue;
    if (!p.rings.some((r) => inRing(x, y, r))) continue;
    if (!p.street) return i;
    if (fallback < 0) fallback = i;
  }
  return fallback;
}

console.log("towns (Danske Stednavne)…");
const filter = TOWN_TYPES.map((t) => `bebyggelsestype='${t}'`).join(" OR ");
const townMembers = await wfsPages(
  STEDNAVNE,
  { typeNames: "sn:Bebyggelse", cql_filter: filter },
  1000,
);
const towns = [];
for (const member of townMembers) {
  const name = field(member, "navn_1.skrivemaade");
  const type = TOWN_TYPES.indexOf(field(member, "bebyggelsestype"));
  const rs = rings(member);
  if (!name || type < 0 || rs.length === 0) continue;
  // the point: the centroid of the largest part, or a vertex-mean fallback
  const largest = rs.reduce((best, r) =>
    Math.abs(ringArea(r)) > Math.abs(ringArea(best)) ? r : best,
  );
  let [x, y] = ringCentroid(largest);
  if (!inRing(x, y, largest)) {
    // a crescent: the middle of the box row through the centroid that is inside
    let found = false;
    for (let i = 0; i < largest.length && !found; i += 2) {
      const mx = (largest[i] + x) / 2;
      const my = (largest[i + 1] + y) / 2;
      if (inRing(mx, my, largest)) {
        x = mx;
        y = my;
        found = true;
      }
    }
  }
  const areaM2 =
    Number(field(member, "areal")) || rs.reduce((sum, r) => sum + Math.abs(ringArea(r)), 0);
  const [lon, lat] = utm32nToWgs84(x, y);
  const district = districtAt(x, y);
  // the radius of a circle of the same area, in km
  const radiusKm = Math.round((Math.sqrt(areaM2 / Math.PI) / 1000) * 10) / 10;
  towns.push([name, r3(lon), r3(lat), radiusKm, district, type]);
}
towns.sort((a, b) => a[0].localeCompare(b[0], "da") || b[3] - a[3]);
console.log(
  `  ${towns.length} towns, ${towns.filter((t) => t[4] < 0).length} outside every district`,
);

const out = {
  about:
    "Byer, bydele og sommerhusområder (Danske Stednavne, sn:Bebyggelse) og postnumre (DAGI Postnummerinddeling), Klimadatastyrelsen via Datafordeler. Lavet af web/scripts/gen-places.mjs.",
  generated: new Date().toISOString().slice(0, 10),
  // [postnr, name, west, south, east, north]
  postal: postal.map((p) => {
    const [w, s] = utm32nToWgs84(p.box[0], p.box[1]);
    const [e, n] = utm32nToWgs84(p.box[2], p.box[3]);
    return [p.postnr, p.name, r3(w), r3(s), r3(e), r3(n)];
  }),
  // [name, lon, lat, radiusKm, postal index (-1: none), type: 0 by, 1 bydel, 2 sommerhusområde]
  towns,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out) + "\n");
console.log(`wrote ${OUT} (${Math.round(fs.statSync(OUT).size / 1024)} kB)`);
