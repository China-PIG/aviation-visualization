#!/usr/bin/env python3
"""Build the offline global flight view from a frozen observation snapshot."""
import argparse
import base64
import json
from math import isfinite
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data/global"
SNAPSHOT = DATA / "snapshot.json"


def number(value):
    return isinstance(value, (int, float)) and isfinite(value)


def normalize(source):
    """Keep display fields and rounded locations for the course visualization."""
    payload = json.loads(source.read_text(encoding="utf-8"))
    observed_at = payload["time"]
    records = []
    for row in payload["states"]:
        (_, _, _, last_position, _, lon, lat, baro, on_ground,
         speed, heading, _, _, geo, *_) = row
        if on_ground or not all(map(number, (last_position, lon, lat))):
            continue
        if not -180 <= lon <= 180 or not -90 <= lat <= 90 or not 0 <= observed_at - last_position <= 60:
            continue
        altitude = baro if number(baro) else geo
        records.append([
            round(lon, 2), round(lat, 2),
            round(altitude / 100) * 100 if number(altitude) else None,
            round(speed * 3.6 / 5) * 5 if number(speed) else None,
            round(heading) % 360 if number(heading) else None,
            observed_at - last_position,
        ])
    if not records:
        raise ValueError("快照没有符合条件的空中观测")
    records.sort(key=lambda row: (row[0], row[1], row[5]))
    return {"observedAt": observed_at, "aircraft": records}


def build_global():
    snapshot = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    if not snapshot["aircraft"]:
        raise ValueError("全球航班快照为空")
    source = ROOT / "src"
    shell = (source / "global.html").read_text(encoding="utf-8")
    countries = json.loads((DATA / "countries.json").read_text(encoding="utf-8"))
    cities = json.loads((DATA / "cities.json").read_text(encoding="utf-8"))
    texture = base64.b64encode((DATA / "blue-marble.jpg").read_bytes()).decode("ascii")
    html = (shell.replace("<!-- STYLE -->", (source / "global.css").read_text(encoding="utf-8"))
            .replace("<!-- COUNTRY CODE -->", (source / "countries.js").read_text(encoding="utf-8"))
            .replace("<!-- COUNTRIES -->", json.dumps(countries, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c"))
            .replace("<!-- CITIES -->", json.dumps(cities, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c"))
            .replace("<!-- COMPONENT -->", (source / "global.js").read_text(encoding="utf-8"))
            .replace("<!-- SNAPSHOT -->", json.dumps(snapshot, separators=(",", ":")))
            .replace("<!-- TEXTURE -->", "data:image/jpeg;base64," + texture))
    dist = ROOT / "dist"
    dist.mkdir(exist_ok=True)
    (dist / "global.html").write_text(html, encoding="utf-8")
    print(f"Built dist/global.html ({len(snapshot['aircraft']):,} airborne observations)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--opensky", type=Path, help="保存到本机的 OpenSky states/all JSON 响应")
    args = parser.parse_args()
    if args.opensky:
        snapshot = normalize(args.opensky)
        SNAPSHOT.write_text(json.dumps(snapshot, separators=(",", ":")), encoding="utf-8")
    build_global()
