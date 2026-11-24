#!/usr/bin/env python3
"""Prepare display names and label priorities from Natural Earth populated places."""
import argparse
import json
from io import BytesIO
from zipfile import ZipFile

from build_global import DATA


def prepare(archive_path):
    import shapefile

    basename = "ne_10m_populated_places"
    fields = ["NAME", "NAME_ZH", "SCALERANK", "POP_MAX", "ADM0CAP", "FEATURECLA"]
    with ZipFile(archive_path) as archive:
        source = shapefile.Reader(**{
            kind: BytesIO(archive.read(f"{basename}.{kind}"))
            for kind in ("shp", "shx", "dbf")
        })
        cities = []
        for entry in source.iterShapeRecords(fields=fields):
            row = entry.record.as_dict()
            if row["FEATURECLA"] == "Scientific station":
                continue
            name = row["NAME_ZH"] or row["NAME"]
            lon, lat = entry.shape.points[0]
            rank = min(2, row["SCALERANK"]) if row["ADM0CAP"] else row["SCALERANK"]
            cities.append((rank, -row["POP_MAX"], name, round(lon, 3), round(lat, 3)))
    return [[name, lon, lat, rank] for rank, _, name, lon, lat in sorted(cities)]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", help="Natural Earth 1:10m Populated Places ZIP")
    cities = prepare(parser.parse_args().archive)
    (DATA / "cities.json").write_text(json.dumps(cities, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Prepared {len(cities):,} city and town labels")
