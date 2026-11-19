"""Geometry for named-forest outlines: simplify, validate, pick an inside point, encode.

Pure functions, no I/O. `pipeline.ingest.stednavne` uses them to turn each
Danske Stednavne forest polygon into a light outline (and a point that is
really inside the forest), `pipeline.publish.site` to write the compact
`forest-outlines.json` the web app loads on demand. See
docs/adr/0020-forest-outlines-for-the-pin.md.

Conventions: a *ring* is a list of `(lon, lat)` pairs, closed (first == last);
a *polygon* is `[outer, hole, hole, ...]`; an *outline* is a list of polygons
(the parts of one forest). Distances are worked out on a local flat grid in
metres, which is accurate to well under a metre over a forest's extent at
Denmark's latitude.
"""

from __future__ import annotations

import math

Point = tuple[float, float]
Ring = list[Point]
Polygon = list[Ring]
Outline = list[Polygon]

#: Douglas-Peucker tolerance. A forest edge drawn at the app's closest zoom
#: (about 2 m per pixel) is off by at most ~12 px, and by under 2 px at the
#: zoom where a whole forest is in view; "is the pin inside" is decided with a
#: margin several times this (the web app's PIN_EDGE_MARGIN_KM).
SIMPLIFY_TOLERANCE_M = 25.0
#: Published coordinates keep five decimals: about 1.1 m north-south, 0.6 m
#: east-west at 56 N.
COORD_DECIMALS = 5
COORD_SCALE = 10**COORD_DECIMALS
#: Holes (clearings, lakes) smaller than this are dropped: they are below what
#: the pin rule's margin can tell apart anyway.
MIN_HOLE_AREA_M2 = 20_000.0

_M_PER_DEG_LAT = 110_540.0
_M_PER_DEG_LON_EQUATOR = 111_320.0


def _to_metres(ring: Ring) -> list[Point]:
    """Project a ring to a local flat grid (metres) around its own mid-latitude."""
    lat0 = sum(lat for _lon, lat in ring) / len(ring)
    kx = _M_PER_DEG_LON_EQUATOR * math.cos(math.radians(lat0))
    return [(lon * kx, lat * _M_PER_DEG_LAT) for lon, lat in ring]


def ring_area_m2(ring: Ring) -> float:
    """Unsigned area of a closed ring, in square metres (shoelace on the flat grid)."""
    if len(ring) < 4:
        return 0.0
    pts = _to_metres(ring)
    total = 0.0
    for (x0, y0), (x1, y1) in zip(pts, pts[1:], strict=False):
        total += x0 * y1 - x1 * y0
    return abs(total) / 2.0


def close_ring(ring: Ring) -> Ring:
    """The ring with its first point repeated at the end, if it was not already."""
    if ring and ring[0] != ring[-1]:
        return [*ring, ring[0]]
    return ring


def _douglas_peucker(pts: list[Point], tolerance: float) -> list[int]:
    """Indices of the points an open polyline keeps (iterative, no recursion limit)."""
    keep = {0, len(pts) - 1}
    stack = [(0, len(pts) - 1)]
    while stack:
        first, last = stack.pop()
        if last - first < 2:
            continue
        (x0, y0), (x1, y1) = pts[first], pts[last]
        dx, dy = x1 - x0, y1 - y0
        length_sq = dx * dx + dy * dy
        worst = -1.0
        worst_index = -1
        for i in range(first + 1, last):
            px, py = pts[i]
            if length_sq == 0.0:
                dist_sq = (px - x0) ** 2 + (py - y0) ** 2
            else:
                t = max(0.0, min(1.0, ((px - x0) * dx + (py - y0) * dy) / length_sq))
                dist_sq = (px - (x0 + t * dx)) ** 2 + (py - (y0 + t * dy)) ** 2
            if dist_sq > worst:
                worst = dist_sq
                worst_index = i
        if worst > tolerance * tolerance:
            keep.add(worst_index)
            stack.append((first, worst_index))
            stack.append((worst_index, last))
    return sorted(keep)


def _segments_cross(a: Point, b: Point, c: Point, d: Point) -> bool:
    """True when segments ab and cd properly cross (touching at endpoints does not count)."""

    def orient(p: Point, q: Point, r: Point) -> float:
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    d1 = orient(c, d, a)
    d2 = orient(c, d, b)
    d3 = orient(a, b, c)
    d4 = orient(a, b, d)
    return ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0)) and 0 not in (d1, d2, d3, d4)


def ring_is_simple(ring: Ring) -> bool:
    """A usable ring: closed, at least a triangle, with area, and not crossing itself."""
    if len(ring) < 4 or ring[0] != ring[-1] or ring_area_m2(ring) <= 0.0:
        return False
    n = len(ring) - 1  # number of edges
    for i in range(n):
        a, b = ring[i], ring[i + 1]
        min_x, max_x = min(a[0], b[0]), max(a[0], b[0])
        for j in range(i + 2, n):
            if i == 0 and j == n - 1:
                continue  # the first and last edge share the closing point
            c, d = ring[j], ring[j + 1]
            if max(c[0], d[0]) < min_x or min(c[0], d[0]) > max_x:
                continue
            if _segments_cross(a, b, c, d):
                return False
    return True


def _round_ring(ring: Ring) -> Ring:
    """Round to the published precision and drop points that then coincide."""
    out: Ring = []
    for lon, lat in ring:
        point = (round(lon, COORD_DECIMALS), round(lat, COORD_DECIMALS))
        if not out or out[-1] != point:
            out.append(point)
    return close_ring(out)


def simplify_ring(ring: Ring, tolerance_m: float = SIMPLIFY_TOLERANCE_M) -> Ring | None:
    """A closed ring simplified to `tolerance_m` and rounded for publishing.

    Douglas-Peucker can, rarely, make a winding boundary cross itself; when it
    does the tolerance is halved (up to three times) and, failing that, the
    ring is kept unsimplified. Returns None for a ring that is not a usable
    polygon to begin with (fewer than three distinct corners, or no area).
    """
    ring = close_ring(list(ring))
    if len(ring) < 4:
        return None
    pts = _to_metres(ring)
    # Split the closed ring at the point farthest from its start, so the two
    # halves are open polylines with fixed, well-separated ends.
    x0, y0 = pts[0]
    far = max(range(len(pts) - 1), key=lambda i: (pts[i][0] - x0) ** 2 + (pts[i][1] - y0) ** 2)
    if far == 0:
        return None
    tolerance = tolerance_m
    for _attempt in range(4):
        first = _douglas_peucker(pts[: far + 1], tolerance)
        second = [far + i for i in _douglas_peucker(pts[far:], tolerance)]
        indices = first + second[1:]
        candidate = _round_ring([ring[i] for i in indices])
        if ring_is_simple(candidate):
            return candidate
        tolerance /= 2.0
    full = _round_ring(ring)
    return full if ring_is_simple(full) else None


def simplify_outline(polygons: Outline, tolerance_m: float = SIMPLIFY_TOLERANCE_M) -> Outline:
    """Every part of a forest simplified; holes below MIN_HOLE_AREA_M2 dropped.

    A part whose outer ring is unusable is dropped whole; a hole that is
    unusable after simplification is dropped (the forest then covers it).
    """
    out: Outline = []
    for polygon in polygons:
        if not polygon:
            continue
        outer = simplify_ring(polygon[0], tolerance_m)
        if outer is None:
            continue
        rings = [outer]
        for hole in polygon[1:]:
            if ring_area_m2(close_ring(list(hole))) < MIN_HOLE_AREA_M2:
                continue
            simplified = simplify_ring(hole, tolerance_m)
            if simplified is not None:
                rings.append(simplified)
        out.append(rings)
    return out


def point_in_ring(lon: float, lat: float, ring: Ring) -> bool:
    """Even-odd ray cast; a point exactly on the boundary may land either way."""
    inside = False
    for (x0, y0), (x1, y1) in zip(ring, ring[1:], strict=False):
        if (y0 > lat) != (y1 > lat) and lon < x0 + (lat - y0) * (x1 - x0) / (y1 - y0):
            inside = not inside
    return inside


def point_in_outline(lon: float, lat: float, polygons: Outline) -> bool:
    """Inside any part's outer ring and outside that part's holes."""
    for polygon in polygons:
        if point_in_ring(lon, lat, polygon[0]) and not any(
            point_in_ring(lon, lat, hole) for hole in polygon[1:]
        ):
            return True
    return False


def polygon_centroid(ring: Ring) -> Point:
    """Area-weighted centroid of a closed ring (flat-Cartesian in degrees: an
    adequate approximation for a forest-sized polygon at Denmark's latitude)."""
    area = 0.0
    cx = 0.0
    cy = 0.0
    for (x0, y0), (x1, y1) in zip(ring, ring[1:], strict=False):
        cross = x0 * y1 - x1 * y0
        area += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    area *= 0.5
    if abs(area) < 1e-12:
        lons = [p[0] for p in ring]
        lats = [p[1] for p in ring]
        return sum(lons) / len(lons), sum(lats) / len(lats)
    return cx / (6 * area), cy / (6 * area)


def point_on_surface(polygons: Outline) -> Point | None:
    """A point that is inside the forest: the centroid of its largest part when
    that lies inside, otherwise the middle of the widest stretch of forest
    along the west-east line through that centroid's latitude.

    A crescent- or ring-shaped forest has its centroid outside itself; a pin
    put "on the forest" must still be in it.
    """
    if not polygons:
        return None
    largest = max(polygons, key=lambda polygon: ring_area_m2(polygon[0]))
    lon, lat = polygon_centroid(largest[0])
    if point_in_outline(lon, lat, [largest]):
        return lon, lat
    lats = [p[1] for p in largest[0]]
    for scan_lat in (lat, (min(lats) + max(lats)) / 2.0):
        crossings: list[float] = []
        for ring in largest:
            for (x0, y0), (x1, y1) in zip(ring, ring[1:], strict=False):
                if (y0 > scan_lat) != (y1 > scan_lat):
                    crossings.append(x0 + (scan_lat - y0) * (x1 - x0) / (y1 - y0))
        crossings.sort()
        # Between the 1st and 2nd crossing the line is inside, between the 2nd
        # and 3rd outside (or in a hole), and so on.
        spans = [(crossings[i + 1] - crossings[i], i) for i in range(0, len(crossings) - 1, 2)]
        if spans:
            _width, i = max(spans)
            return (crossings[i] + crossings[i + 1]) / 2.0, scan_lat
    return lon, lat


def distance_to_outline_m(lon: float, lat: float, polygons: Outline) -> float:
    """Distance in metres from a point to the nearest edge of any ring."""
    kx = _M_PER_DEG_LON_EQUATOR * math.cos(math.radians(lat))
    best = math.inf
    for polygon in polygons:
        for ring in polygon:
            for (x0, y0), (x1, y1) in zip(ring, ring[1:], strict=False):
                ax, ay = (x0 - lon) * kx, (y0 - lat) * _M_PER_DEG_LAT
                bx, by = (x1 - lon) * kx, (y1 - lat) * _M_PER_DEG_LAT
                dx, dy = bx - ax, by - ay
                length_sq = dx * dx + dy * dy
                t = (
                    0.0
                    if length_sq == 0.0
                    else max(0.0, min(1.0, -(ax * dx + ay * dy) / length_sq))
                )
                best = min(best, math.hypot(ax + t * dx, ay + t * dy))
    return best


def outline_bbox(polygons: Outline) -> tuple[float, float, float, float]:
    """(west, south, east, north) of the outer rings."""
    xs = [x for polygon in polygons for x, _y in polygon[0]]
    ys = [y for polygon in polygons for _x, y in polygon[0]]
    return min(xs), min(ys), max(xs), max(ys)


#: A published point is kept at least this far inside its forest's edge where
#: the forest is wide enough: well clear of the rounding to COORD_DECIMALS.
MIN_POINT_CLEARANCE_M = 5.0


def published_point(lon: float, lat: float) -> Point:
    """A point as it is published (rounded to COORD_DECIMALS)."""
    return round(lon, COORD_DECIMALS), round(lat, COORD_DECIMALS)


def point_is_sound(lon: float, lat: float, polygons: Outline, avoid: list[Outline]) -> bool:
    """A good point to publish for a forest: inside it once rounded, clear of
    its edge, and not inside any of the `avoid` forests (the smaller named
    forests that lie in it, which would otherwise claim a pin put there)."""
    lon, lat = published_point(lon, lat)
    return (
        point_in_outline(lon, lat, polygons)
        and distance_to_outline_m(lon, lat, polygons) >= MIN_POINT_CLEARANCE_M
        and not any(point_in_outline(lon, lat, other) for other in avoid)
    )


def clear_inside_point(polygons: Outline, avoid: list[Outline], grid: int = 24) -> Point | None:
    """The point of the forest that is furthest from every edge -- its own and
    those of the `avoid` forests -- among a grid over its extent; None when no
    grid point is in the forest and outside all of `avoid` (a forest wholly
    covered by smaller named ones).

    Used when the plain `point_on_surface` is not sound (`point_is_sound`):
    it then gives a pin put "on" the forest the best chance of being in that
    forest and in no other.
    """
    if not polygons:
        return None
    west, south, east, north = outline_bbox(polygons)
    best: tuple[float, Point] | None = None
    for i in range(1, grid):
        for j in range(1, grid):
            lon, lat = published_point(
                west + (east - west) * i / grid, south + (north - south) * j / grid
            )
            if not point_in_outline(lon, lat, polygons):
                continue
            if any(point_in_outline(lon, lat, other) for other in avoid):
                continue
            clearance = distance_to_outline_m(lon, lat, polygons)
            for other in avoid:
                if clearance <= (best[0] if best else 0.0):
                    break
                clearance = min(clearance, distance_to_outline_m(lon, lat, other))
            if best is None or clearance > best[0]:
                best = (clearance, (lon, lat))
    return best[1] if best else None


def encode_ring(ring: Ring) -> list[int]:
    """A closed ring as a flat list of integers: the first corner in 1e-5
    degrees (lon, lat), then each next corner as a difference from the one
    before. The closing point is left out (it repeats the first)."""
    out: list[int] = []
    prev_x = prev_y = 0
    for lon, lat in ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else ring:
        x = round(lon * COORD_SCALE)
        y = round(lat * COORD_SCALE)
        out.extend((x - prev_x, y - prev_y))
        prev_x, prev_y = x, y
    return out


def decode_ring(values: list[int]) -> Ring:
    """Inverse of encode_ring: a closed ring of (lon, lat) pairs."""
    ring: Ring = []
    x = y = 0
    for i in range(0, len(values) - 1, 2):
        x += values[i]
        y += values[i + 1]
        ring.append((x / COORD_SCALE, y / COORD_SCALE))
    return close_ring(ring)


def encode_outline(polygons: Outline) -> list[list[list[int]]]:
    return [[encode_ring(ring) for ring in polygon] for polygon in polygons]
