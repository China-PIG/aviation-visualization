#!/usr/bin/env python3
"""Prepare compact country/region polygons from Natural Earth Admin 0 (China POV)."""
import argparse
import json
from io import BytesIO
from zipfile import ZipFile

from build_global import DATA

BASENAME = "ne_10m_admin_0_countries_chn"
NAMES_ZH = {"CHN": "中国", "HKG": "中国香港", "MAC": "中国澳门"}


def polygon_parts(geometry):
    if geometry.is_empty:
        return
    if geometry.geom_type == "Polygon":
        yield geometry
    elif geometry.geom_type in {"MultiPolygon", "GeometryCollection"}:
        for part in geometry.geoms:
            yield from polygon_parts(part)


def prepare(archive_path):
    # These packages are needed only to regenerate the bundled boundary snapshot.
    import shapefile
    from shapely import make_valid, set_precision
    from shapely.geometry import shape

    with ZipFile(archive_path) as archive:
        source = shapefile.Reader(**{
            kind: BytesIO(archive.read(f"{BASENAME}.{kind}"))
            for kind in ("shp", "shx", "dbf")
        })
        areas = []
        for entry in source.iterShapeRecords():
            row = entry.record.as_dict()
            code = row["ADM0_A3"]
            geometry = shape(entry.shape.__geo_interface__)
            if not geometry.is_valid:
                geometry = make_valid(geometry)
            simplified = geometry.simplify(0.02, preserve_topology=True)
            if not simplified.is_valid:
                simplified = make_valid(simplified)
            rings = []
            for polygon in polygon_parts(set_precision(simplified, 0.001)):
                paths = []
                for ring in [polygon.exterior, *polygon.interiors]:
                    points = [[round(lon, 3), round(lat, 3)] for lon, lat in list(ring.coords)[:-1]]
                    if len({tuple(point) for point in points}) >= 3:
                        paths.append(points)
                if paths:
                    rings.append(paths)
            if rings:
                label = [round(row["LABEL_X"], 2), round(row["LABEL_Y"], 2)]
                areas.append([code, NAMES_ZH.get(code, row["NAME_ZH"] or row["NAME"]),
                              row["NAME"], label, rings])

    areas.sort(key=lambda entry: entry[0])
    if len(areas) != len({entry[0] for entry in areas}) or "CHN" not in {entry[0] for entry in areas}:
        raise ValueError("国家或地区代码缺失或重复")
    return areas


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", help="Natural Earth Admin 0 Countries (China POV) ZIP")
    areas = prepare(parser.parse_args().archive)
    target = DATA / "countries.json"
    target.write_text(json.dumps(areas, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Prepared {len(areas)} areas in {target}")
