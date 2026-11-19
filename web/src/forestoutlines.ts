// Outlines of the named forests (forest-outlines-<n>.json, written by
// pipeline/publish/site.py): decoding, the point-in-forest and
// distance-to-edge geometry, and the store that fetches one band of the
// country at a time. With them, "the forest at the pin" is the forest the pin
// is inside (forests.ts's forestAtPin); without them the app falls back to the
// forest points alone. See docs/adr/0020-forest-outlines-for-the-pin.md.
//
// Shapes are kept as flat number arrays: a ring is [lon, lat, lon, lat, ...],
// closed (the first corner repeated at the end).

/** One outline file, as the manifest lists it. */
export interface OutlineFileRef {
  file: string;
  /** The forests in the file: `count` of them from index `start` in forests.json. */
  start: number;
  count: number;
  /** west, south, east, north of everything in the file. */
  bbox: [number, number, number, number];
  /** Identifies the forests.json the file belongs to; the file carries the
   * same one. Missing in a payload published before stamps. */
  stamp?: string;
}

/** A forest-outlines-<n>.json document. */
export interface OutlineFileDoc {
  version: number;
  scale: number;
  start: number;
  count: number;
  stamp?: string | null;
  /** Per forest: its polygons, each a list of rings (outer first, then
   * holes), each ring delta-coded integers; or null for a forest without one. */
  forests: (number[][][] | null)[];
}

export interface ForestShape {
  /** The parts of the forest: each [outer ring, ...holes]. */
  polygons: number[][][];
  /** west, south, east, north. */
  bbox: [number, number, number, number];
}

const KM_PER_DEG_LAT = 110.54;
const KM_PER_DEG_LON_EQUATOR = 111.32;
const kmPerDegLon = (lat: number): number =>
  KM_PER_DEG_LON_EQUATOR * Math.cos((lat * Math.PI) / 180);

/** A delta-coded ring (see pipeline.forest_outlines.encode_ring) as a closed
 * flat ring of degrees. */
export function decodeRing(values: readonly number[], scale: number): number[] {
  const ring: number[] = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i + 1 < values.length; i += 2) {
    x += values[i];
    y += values[i + 1];
    ring.push(x / scale, y / scale);
  }
  if (ring.length >= 2) ring.push(ring[0], ring[1]); // the closing point is not stored
  return ring;
}

export function decodeShape(encoded: readonly number[][][], scale: number): ForestShape | null {
  const polygons = encoded
    .map((polygon) => polygon.map((ring) => decodeRing(ring, scale)).filter((r) => r.length >= 8))
    .filter((polygon) => polygon.length > 0);
  if (polygons.length === 0) return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const polygon of polygons) {
    const outer = polygon[0];
    for (let i = 0; i < outer.length; i += 2) {
      west = Math.min(west, outer[i]);
      east = Math.max(east, outer[i]);
      south = Math.min(south, outer[i + 1]);
      north = Math.max(north, outer[i + 1]);
    }
  }
  return { polygons, bbox: [west, south, east, north] };
}

/** Even-odd ray cast against one closed flat ring. */
export function pointInRing(lon: number, lat: number, ring: readonly number[]): boolean {
  let inside = false;
  for (let i = 0; i + 3 < ring.length; i += 2) {
    const x0 = ring[i];
    const y0 = ring[i + 1];
    const x1 = ring[i + 2];
    const y1 = ring[i + 3];
    if (y0 > lat !== y1 > lat && lon < x0 + ((lat - y0) * (x1 - x0)) / (y1 - y0)) inside = !inside;
  }
  return inside;
}

/** Inside one of the forest's parts, and not in one of that part's holes. */
export function pointInShape(lon: number, lat: number, shape: ForestShape): boolean {
  const [west, south, east, north] = shape.bbox;
  if (lon < west || lon > east || lat < south || lat > north) return false;
  for (const polygon of shape.polygons) {
    if (!pointInRing(lon, lat, polygon[0])) continue;
    let inHole = false;
    for (let h = 1; h < polygon.length; h++) {
      if (pointInRing(lon, lat, polygon[h])) inHole = true;
    }
    if (!inHole) return true;
  }
  return false;
}

/** Shortest distance from a point to a ring's edge, in km (on a local flat
 * grid: well under a metre off at the distances that matter here). */
export function distanceToRingKm(lon: number, lat: number, ring: readonly number[]): number {
  const kx = kmPerDegLon(lat);
  let best = Infinity;
  for (let i = 0; i + 3 < ring.length; i += 2) {
    const ax = (ring[i] - lon) * kx;
    const ay = (ring[i + 1] - lat) * KM_PER_DEG_LAT;
    const bx = (ring[i + 2] - lon) * kx;
    const by = (ring[i + 3] - lat) * KM_PER_DEG_LAT;
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    // the nearest point of segment ab to the origin (the pin)
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSq));
    const px = ax + t * dx;
    const py = ay + t * dy;
    best = Math.min(best, Math.hypot(px, py));
  }
  return best;
}

/** Distance from a point to the forest: 0 inside it, otherwise to its nearest
 * edge (a hole's edge counts: standing in a clearing is being beside the forest). */
export function distanceToShapeKm(lon: number, lat: number, shape: ForestShape): number {
  if (pointInShape(lon, lat, shape)) return 0;
  let best = Infinity;
  for (const polygon of shape.polygons) {
    for (const ring of polygon) best = Math.min(best, distanceToRingKm(lon, lat, ring));
  }
  return best;
}

/** No nearer than this to the shape, from its bounding box alone (km): a
 * cheap test to skip the edge walk for forests that are clearly too far. */
export function bboxDistanceKm(lon: number, lat: number, shape: ForestShape): number {
  const [west, south, east, north] = shape.bbox;
  const dx = Math.max(west - lon, 0, lon - east) * kmPerDegLon(lat);
  const dy = Math.max(south - lat, 0, lat - north) * KM_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

/** Area of the forest in m² (outer rings less holes), for forests the
 * register gives no area for. */
export function shapeAreaM2(shape: ForestShape): number {
  let total = 0;
  for (const polygon of shape.polygons) {
    polygon.forEach((ring, r) => {
      const kx = kmPerDegLon(ring[1]) * 1000;
      const ky = KM_PER_DEG_LAT * 1000;
      let sum = 0;
      for (let i = 0; i + 3 < ring.length; i += 2) {
        sum += ring[i] * kx * (ring[i + 3] * ky) - ring[i + 2] * kx * (ring[i + 1] * ky);
      }
      total += (r === 0 ? 1 : -1) * Math.abs(sum / 2);
    });
  }
  return Math.max(0, total);
}

/** The shape as a GeoJSON geometry, for drawing on the map. */
export function shapeToGeoJSON(shape: ForestShape): GeoJSON.MultiPolygon {
  const pairs = (ring: readonly number[]): [number, number][] => {
    const out: [number, number][] = [];
    for (let i = 0; i + 1 < ring.length; i += 2) out.push([ring[i], ring[i + 1]]);
    return out;
  };
  return {
    type: "MultiPolygon",
    coordinates: shape.polygons.map((polygon) => polygon.map(pairs)),
  };
}

/** How well the outlines cover a spot:
 *  - "ready": every band that could hold a forest there is loaded;
 *  - "pending": one of them is on its way -- however long it takes, the
 *    caller shows that it is looking, not a guess it may have to take back;
 *  - "none": no outlines are published, or a band there could not be fetched
 *    or was never asked for (the caller falls back to the forest points). */
export type OutlineCover = "ready" | "pending" | "none";

/** A band's box is widened by this when asking whether a spot needs it, so a
 * pin just outside a forest at the band's edge still gets that forest (km). */
const BAND_REACH_KM = 0.5;

type BandState = "idle" | "loading" | "loaded" | "failed";

/** How long an outline file may take before it counts as failed (ms). The
 * card says it is looking for as long as the file is on its way; past this
 * the forest points decide, and the card gets its name and its action. */
export const OUTLINE_TIMEOUT_MS = 10_000;

interface Band {
  ref: OutlineFileRef;
  state: BandState;
}

/**
 * The outlines fetched so far, by forest index (the index in forests.json).
 * Bands are fetched on demand through `fetchFile` -- for a pin (`request`)
 * and, ahead of one, for the part of the country the map is showing
 * (`requestArea`). `onChange` fires when a band has arrived or failed, so
 * whoever named the pin can look again.
 */
export class ForestOutlines {
  private readonly shapes = new Map<number, ForestShape>();
  private readonly bands: Band[];

  constructor(
    refs: readonly OutlineFileRef[],
    private readonly fetchFile: (file: string) => Promise<OutlineFileDoc>,
    private readonly onChange: () => void = () => {},
    private readonly timeoutMs: number = OUTLINE_TIMEOUT_MS,
    private readonly retryDelayMs: number = 500,
  ) {
    this.bands = refs.map((ref) => ({ ref, state: "idle" as BandState }));
  }

  /** The outline of forest `index`, if its band is loaded and it has one. */
  shape(index: number | undefined): ForestShape | null {
    return index === undefined ? null : (this.shapes.get(index) ?? null);
  }

  /** Every loaded outline with its forest index. */
  entries(): IterableIterator<[number, ForestShape]> {
    return this.shapes.entries();
  }

  private bandsAt(lon: number, lat: number): Band[] {
    const reachLon = BAND_REACH_KM / kmPerDegLon(lat);
    const reachLat = BAND_REACH_KM / KM_PER_DEG_LAT;
    return this.bands.filter(({ ref: { bbox } }) => {
      const [west, south, east, north] = bbox;
      return (
        lon >= west - reachLon &&
        lon <= east + reachLon &&
        lat >= south - reachLat &&
        lat <= north + reachLat
      );
    });
  }

  cover(lon: number, lat: number): OutlineCover {
    if (this.bands.length === 0) return "none";
    const bands = this.bandsAt(lon, lat);
    if (bands.every((band) => band.state === "loaded")) {
      return "ready"; // also outside every band: no forest can be there
    }
    // one that failed or was never asked for: do without the outlines here
    if (bands.some((band) => band.state === "failed" || band.state === "idle")) return "none";
    return "pending";
  }

  /** Start fetching the bands a spot needs (if not already under way). A
   * failed band is tried again: the next pin may come with a connection. */
  request(lon: number, lat: number): void {
    for (const band of this.bandsAt(lon, lat)) this.fetch(band, true);
  }

  /** Start fetching the bands that reach into an area (west, south, east,
   * north), ahead of a pin: so that a pin dropped there has its answer at
   * once. Unlike `request`, a band that failed is left alone -- a pin there
   * will ask again. */
  requestArea(west: number, south: number, east: number, north: number): void {
    for (const band of this.bands) {
      const [w, s, e, n] = band.ref.bbox;
      if (w <= east && e >= west && s <= north && n >= south) this.fetch(band, false);
    }
  }

  /** How many bands have been asked for so far (for tests and the harness). */
  requested(): number {
    return this.bands.filter((band) => band.state !== "idle").length;
  }

  private fetch(band: Band, retryFailed: boolean): void {
    if (band.state === "loading" || band.state === "loaded") return;
    if (band.state === "failed" && !retryFailed) return;
    band.state = "loading";
    // One outcome per attempt: loaded, failed, or -- for a request that never
    // answers -- failed by the clock, so the pin is not left waiting for good.
    // An answer that comes after that is dropped; the next pin asks afresh.
    let settled = false;
    const settle = (state: BandState): void => {
      settled = true;
      clearTimeout(timer);
      band.state = state;
      this.onChange();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      console.error(`${band.ref.file} did not arrive within ${this.timeoutMs} ms`);
      settle("failed");
    }, this.timeoutMs);
    // A fetch that fails outright is tried once more after a moment before it
    // counts: a dropped connection should not cost the pin its forest.
    const attempt = (retriesLeft: number): void => {
      this.fetchFile(band.ref.file).then(
        (doc) => {
          if (settled) return;
          try {
            this.add(doc, band.ref); // throws on a file that does not fit the manifest
            settle("loaded");
          } catch (err) {
            console.error(`could not use ${band.ref.file}`, err);
            settle("failed");
          }
        },
        (err) => {
          if (settled) return;
          if (retriesLeft > 0) {
            setTimeout(() => {
              if (!settled) attempt(retriesLeft - 1);
            }, this.retryDelayMs);
            return;
          }
          console.error(`could not load ${band.ref.file}`, err);
          settle("failed");
        },
      );
    };
    attempt(1);
  }

  /** Take in one file. A file that does not match what the manifest said
   * about it is refused (throws), and its band counts as failed: that covers
   * a manifest and an outline file from different publishes (the `stamp`),
   * which would otherwise pair outlines with the wrong forests. */
  add(doc: OutlineFileDoc, ref: OutlineFileRef): void {
    if (
      doc.version !== 1 ||
      doc.start !== ref.start ||
      doc.count !== ref.count ||
      doc.forests.length !== ref.count ||
      (ref.stamp !== undefined && doc.stamp !== ref.stamp) ||
      !(doc.scale > 0)
    ) {
      throw new Error(`${ref.file} does not match the manifest`);
    }
    doc.forests.forEach((encoded, i) => {
      const shape = encoded ? decodeShape(encoded, doc.scale) : null;
      if (shape) this.shapes.set(doc.start + i, shape);
    });
  }
}
