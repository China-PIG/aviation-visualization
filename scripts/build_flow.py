#!/usr/bin/env python3
"""Build the offline global city-flow page from the aggregated flight dataset."""
import base64
import gzip
import json
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
GLOBAL = DATA / "global"
SOURCE = ROOT / "src"
FLOWS = DATA / "global-flows.json"
ROW = struct.Struct("<BHHH")  # day, from, to, count


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def simplify_ring(ring):
    """Round to 0.01° and drop repeated points so the basemap stays small."""
    points = []
    for lon, lat in ring:
        point = (round(lon, 2), round(lat, 2))
        if not points or point != points[-1]:
            points.append(point)
    if len(points) > 1 and points[0] != points[-1]:
        points.append(points[0])
    return points


def build_world():
    world = []
    for code, _name, _name_en, _center, polygons in read_json(GLOBAL / "countries.json"):
        kept = []
        for polygon in polygons:
            rings = []
            for ring in polygon:
                points = simplify_ring(ring)
                if len(points) >= 4:
                    rings.append([value for point in points for value in point])
            if not rings:
                continue
            xs = [value for ring in rings for value in ring[0::2]]
            ys = [value for ring in rings for value in ring[1::2]]
            # Drop specks that stay under a pixel on the global view.
            if max(xs) - min(xs) < .5 and max(ys) - min(ys) < .5:
                continue
            kept.append(rings)
        if kept:
            world.append([code, kept])
    return world


def build_places():
    """Keep coordinates and the Natural Earth rank; names are unused on the map."""
    return [[round(lon, 2), round(lat, 2), rank]
            for _name, lon, lat, rank in read_json(GLOBAL / "cities.json")]


CHINA_REGIONS = ["华北", "东北", "华东", "华中", "华南", "西南", "西北"]
CHINA_CITY_REGION = {
    "北京": 0, "天津": 0, "石家庄": 0, "太原": 0, "呼和浩特": 0,
    "哈尔滨": 1, "沈阳": 1, "长春": 1, "大连": 1,
    "上海": 2, "杭州": 2, "厦门": 2, "南京": 2, "济南": 2, "青岛": 2,
    "宁波": 2, "温州": 2, "福州": 2, "合肥": 2, "南昌": 2,
    "武汉": 3, "长沙": 3, "郑州": 3,
    "广州": 4, "深圳": 4, "海口": 4, "南宁": 4, "三亚": 4, "珠海": 4,
    "成都": 5, "重庆": 5, "昆明": 5, "贵阳": 5, "拉萨": 5,
    "西安": 6, "兰州": 6, "乌鲁木齐": 6, "西宁": 6, "银川": 6,
}


def add_china_regions(payload):
    for city in payload["cities"]:
        if city.get("country") == "CN":
            city["region"] = CHINA_CITY_REGION.get(city["name"], -1)
    payload["chinaRegions"] = CHINA_REGIONS
    return payload


def pack(rows):
    """Encode rows as fixed-width binary, then gzip + base64 for the HTML."""
    buffer = bytearray(len(rows) * ROW.size)
    for index, (day, origin, destination, count) in enumerate(rows):
        ROW.pack_into(buffer, index * ROW.size, day, origin, destination, count)
    return base64.b64encode(gzip.compress(bytes(buffer), 9)).decode("ascii")


def build():
    payload = add_china_regions(read_json(FLOWS))
    flows = payload["flows"]
    links = payload["links"]
    payload["counts"] = {"flows": len(flows), "links": len(links)}
    payload.pop("source", None)
    payload.pop("counts", None)
    payload["flows"] = pack(flows)
    payload["links"] = pack(links)
    html = (SOURCE / "flow.html").read_text(encoding="utf-8")
    assets = {
        "<!-- STYLE -->": (SOURCE / "flow.css").read_text(encoding="utf-8"),
        "<!-- FLOW DATA -->": json.dumps(payload, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c"),
        "<!-- COUNTRIES -->": json.dumps(build_world(), separators=(",", ":")).replace("<", "\\u003c"),
        "<!-- CITIES -->": json.dumps(build_places(), separators=(",", ":")).replace("<", "\\u003c"),
        "<!-- COMPONENT -->": (SOURCE / "flow.js").read_text(encoding="utf-8"),
    }
    for key, value in assets.items():
        html = html.replace(key, value)
    (ROOT / "dist").mkdir(exist_ok=True)
    out = ROOT / "dist/flow.html"
    out.write_text(html, encoding="utf-8")
    print(f"Built dist/flow.html ({len(payload['cities']):,} cities, {len(payload['countries'])} countries, "
          f"{len(flows):,} city-pair days, {len(links):,} country-pair days, "
          f"{len(payload['months'])} months, {out.stat().st_size / 1048576:.2f} MB)")


if __name__ == "__main__":
    build()
