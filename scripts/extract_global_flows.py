#!/usr/bin/env python3
"""Aggregate OpenSky monthly flight lists into worldwide city and country flows.

Inputs (data/opensky):
  flightlist_YYYYMMDD_YYYYMMDD.csv.gz  monthly flight lists
  airports.csv                         OurAirports airport table (ident, coords, country)
  countries-iso.csv                    ISO 3166 alpha-2 / alpha-3 names

The slow pass (scanning ~4.7M rows) is cached in data/opensky/aggregate.pkl so the
size thresholds below can be tuned without rescanning. Pass --rescan after adding
a monthly file.

Output: data/global-flows.json, embedded into dist/flow.html by build_flow.py.
"""
import csv
import gzip
import json
import pickle
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
OPENSKY = DATA / "opensky"
OUT = DATA / "global-flows.json"
CACHE = OPENSKY / "aggregate.pkl"

CONTINENTS = {"AF": "非洲", "AS": "亚洲", "EU": "欧洲", "NA": "北美洲", "SA": "南美洲", "OC": "大洋洲"}
CITY_MIN_FLIGHTS = 400      # a city gets a node at this monthly volume...
CITY_TOP_PER_COUNTRY = 4    # ...or when it is among its country's busiest
CITY_PAIR_MIN = 60          # city pairs below this monthly volume are not drawn
LOAD_FACTOR = 1.0


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def load_airports():
    table = {}
    with open(OPENSKY / "airports.csv", encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            try:
                lat = float(row["latitude_deg"])
                lon = float(row["longitude_deg"])
            except (KeyError, ValueError):
                continue
            country = (row.get("iso_country") or "").strip()
            if not country:
                continue
            record = {
                "lat": lat,
                "lon": lon,
                "country": country,
                "city": (row.get("municipality") or "").strip() or (row.get("name") or "").strip(),
                "continent": (row.get("continent") or "").strip(),
            }
            for code in ((row.get("ident") or "").strip(), (row.get("icao_code") or "").strip()):
                if code:
                    table.setdefault(code, record)
    return table


def load_countries():
    iso = {}
    with open(OPENSKY / "countries-iso.csv", encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            code2 = (row.get("alpha-2") or "").strip()
            if not code2:
                continue
            region = (row.get("region") or "").strip()
            iso[code2] = {
                "iso3": (row.get("alpha-3") or "").strip(),
                "name": (row.get("name") or "").strip(),
                "region": {"Africa": "AF", "Asia": "AS", "Europe": "EU", "Oceania": "OC"}
                          .get(region, "NA" if region == "Americas" else ""),
            }
    return iso


def load_chinese_names():
    return {code: name_zh for code, name_zh, _en, _center, _polys
            in read_json(DATA / "global" / "countries.json")}


def load_place_names():
    grid = defaultdict(list)
    for name, lon, lat, _rank in read_json(DATA / "global" / "cities.json"):
        grid[(round(lon), round(lat))].append((lon, lat, name))
    return grid


def nearest_name(grid, lon, lat):
    best = None
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for plon, plat, name in grid.get((round(lon) + dx, round(lat) + dy), ()):
                distance = (plon - lon) ** 2 + (plat - lat) ** 2
                if distance < 0.09 and (best is None or distance < best[0]):
                    best = (distance, name)
    return best[1] if best else None


def scan(files):
    airports = load_airports()
    city_sum = {}
    city_pairs = Counter()
    country_pairs = Counter()
    city_day = Counter()
    country_day = Counter()
    months = []
    dates = []

    for path in files:
        days = set()
        with gzip.open(path, "rt", encoding="utf-8", errors="replace", newline="") as handle:
            for row in csv.DictReader(handle):
                origin = airports.get((row.get("origin") or "").strip())
                destination = airports.get((row.get("destination") or "").strip())
                if not origin or not destination:
                    continue
                day = (row.get("day") or "").strip()[:10]
                if not day:
                    continue
                days.add(day)
                a = (origin["country"], origin["city"])
                b = (destination["country"], destination["city"])
                city_pairs[(a, b)] += 1
                country_pairs[(origin["country"], destination["country"])] += 1
                city_day[(a, b, day)] += 1
                country_day[(origin["country"], destination["country"], day)] += 1
                for key, record in ((a, origin), (b, destination)):
                    entry = city_sum.setdefault(key, {"flights": 0, "lon": 0.0, "lat": 0.0, "airports": 0})
                    entry["flights"] += 1
                    entry["lon"] += record["lon"]
                    entry["lat"] += record["lat"]
                    entry["airports"] += 1
        days = sorted(days)
        months.append({"label": f"{days[0][:4]}.{days[0][5:7]}", "start": len(dates), "days": len(days)})
        dates.extend(days)
        print(f"{path.name}: {len(days)} 天, 累计 {sum(days.count(d) for d in days)} 日记录")

    return {"months": months, "dates": dates, "city_sum": city_sum, "city_pairs": city_pairs,
            "country_pairs": country_pairs, "city_day": city_day, "country_day": country_day}


def load_china_sample():
    """Domestic 2015 sample used to fill mainland China, which OpenSky barely sees."""
    sample = DATA / "flight-sample.csv.gz"
    airports = read_json(DATA / "airports.json")
    if not sample.exists() or not airports:
        return {}, Counter()
    by_code = {airport["code"]: airport["city"] for airport in airports}
    cities = {}
    for airport in airports:
        entry = cities.setdefault(airport["city"], {"lon": 0.0, "lat": 0.0, "airports": 0})
        entry["lon"] += airport["lon"]
        entry["lat"] += airport["lat"]
        entry["airports"] += 1
    for entry in cities.values():
        entry["lon"] /= entry["airports"]
        entry["lat"] /= entry["airports"]
    counts = Counter()
    with gzip.open(sample, "rt", encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            origin = by_code.get(row["origin"])
            destination = by_code.get(row["destination"])
            if origin and destination:
                counts[(row["date"], origin, destination)] += 1
    return cities, counts


def build(aggregate):
    iso = load_countries()
    zh = load_chinese_names()
    places = load_place_names()
    dates = aggregate["dates"]
    for month in aggregate["months"]:
        start_date = dates[month["start"]]
        month["label"] = f"{start_date[:4]}.{start_date[5:7]}"
    city_sum = aggregate["city_sum"]
    city_pairs = aggregate["city_pairs"]
    country_pairs = aggregate["country_pairs"]
    city_day = aggregate["city_day"]

    china_cities, china_counts = load_china_sample()
    china_names = set()
    for name, meta in china_cities.items():
        total = sum(value for (_date, a, b), value in china_counts.items() if name in (a, b))
        if not total:
            continue
        china_names.add(name)
        entry = city_sum.setdefault(("CN", name), {"flights": 0, "lon": 0.0, "lat": 0.0, "airports": 0})
        entry["flights"] += total
        entry["lon"] += meta["lon"] * total
        entry["lat"] += meta["lat"] * total
        entry["airports"] += total

    by_country = defaultdict(list)
    for key, entry in city_sum.items():
        by_country[key[0]].append((entry["flights"], key))
    keep = set()
    for entries in by_country.values():
        entries.sort(reverse=True)
        keep.update(key for _flights, key in entries[:CITY_TOP_PER_COUNTRY])
    keep.update(key for key, entry in city_sum.items() if entry["flights"] >= CITY_MIN_FLIGHTS)
    keep.update(("CN", name) for name in china_names)

    cities = []
    city_index = {}
    for key in sorted(keep, key=lambda k: -city_sum[k]["flights"]):
        entry = city_sum[key]
        lon = entry["lon"] / entry["airports"]
        lat = entry["lat"] / entry["airports"]
        city_index[key] = len(cities)
        cities.append({
            "name": nearest_name(places, lon, lat) or key[1],
            "lon": round(lon, 3),
            "lat": round(lat, 3),
            "country": key[0],
            "continent": iso.get(key[0], {}).get("region", ""),
        })

    used = Counter()
    for (a, b), value in country_pairs.items():
        used[a] += value
        used[b] += value
    countries = []
    country_index = {}
    for code2, _value in used.most_common():
        info = iso.get(code2, {"iso3": "", "name": code2, "region": ""})
        country_index[code2] = len(countries)
        countries.append({
            "name": zh.get(info["iso3"]) or info["name"],
            "code": code2,
            "continent": info["region"],
        })

    day_index = {day: index for index, day in enumerate(dates)}
    flows = []
    self_pairs = 0
    for (a, b, day), value in city_day.items():
        if a == b:
            self_pairs += value
            continue
        if a not in city_index or b not in city_index:
            continue
        if city_pairs[(a, b)] < CITY_PAIR_MIN:
            continue
        flows.append([day_index[day], city_index[a], city_index[b], value])

    links = []
    for (a, b, day), value in aggregate["country_day"].items():
        links.append([day_index[day], country_index[a], country_index[b], value])

    # Replay the Chinese sample into every month so the country is not empty.
    china_flows = []
    china_links = Counter()
    for month in aggregate["months"]:
        for (date, a, b), value in china_counts.items():
            offset = int(date[8:10]) - 1
            if offset >= month["days"]:
                continue
            day = month["start"] + offset
            if city_index[("CN", a)] == city_index[("CN", b)]:
                continue
            china_flows.append([day, city_index[("CN", a)], city_index[("CN", b)], value])
            china_links[(day, country_index["CN"], country_index["CN"])] += value
    flows.extend(china_flows)
    for (day, a, b), value in china_links.items():
        links.append([day, a, b, value])

    def centroid(points):
        return (round(sum(p[0] for p in points) / len(points), 3),
                round(sum(p[1] for p in points) / len(points), 3))

    for country in countries:
        points = [(c["lon"], c["lat"]) for c in cities if c["country"] == country["code"]]
        country["lon"], country["lat"] = centroid(points) if points else (0.0, 0.0)

    continents = []
    for code3, name in CONTINENTS.items():
        points = [(c["lon"], c["lat"]) for c in cities if c["continent"] == code3]
        if not points:
            continue
        lon, lat = centroid(points)
        continents.append({"name": name, "code": code3, "lon": lon, "lat": lat})

    payload = {
        "source": "OpenSky Network flight lists (CC BY 4.0)",
        "months": aggregate["months"],
        "dates": dates,
        "cities": cities,
        "countries": countries,
        "continents": continents,
        "flows": flows,
        "links": links,
    }
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    OUT.write_text(text, encoding="utf-8")
    print(f"cities {len(cities):,} | countries {len(countries)} | continents {len(continents)}")
    print(f"city flows {len(flows):,} (其中中国样本 {len(china_flows):,}) | country links {len(links):,}")
    print(f"同城内航段已剔除 {self_pairs:,} 条 | payload {len(text) / 1048576:.2f} MB")


def main():
    import argparse
    import sys

    global CITY_MIN_FLIGHTS, CITY_TOP_PER_COUNTRY, CITY_PAIR_MIN
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rescan", action="store_true", help="忽略缓存，重新扫描月度文件")
    parser.add_argument("--city-min", type=int, default=CITY_MIN_FLIGHTS)
    parser.add_argument("--country-top", type=int, default=CITY_TOP_PER_COUNTRY)
    parser.add_argument("--pair-min", type=int, default=CITY_PAIR_MIN)
    args = parser.parse_args()

    CITY_MIN_FLIGHTS = args.city_min
    CITY_TOP_PER_COUNTRY = args.country_top
    CITY_PAIR_MIN = args.pair_min

    files = sorted(OPENSKY.glob("flightlist_*.csv.gz"))
    if not files:
        raise SystemExit("没有找到 data/opensky/flightlist_*.csv.gz")
    if CACHE.exists() and not args.rescan:
        aggregate = pickle.loads(CACHE.read_bytes())
        print(f"使用缓存 {CACHE.name}（{len(aggregate['dates'])} 天）")
    else:
        aggregate = scan(files)
        CACHE.write_bytes(pickle.dumps(aggregate, protocol=4))
        print(f"已缓存 {CACHE.name}")
    build(aggregate)
    print(f"参数：city-min={CITY_MIN_FLIGHTS} country-top={CITY_TOP_PER_COUNTRY} pair-min={CITY_PAIR_MIN}")


if __name__ == "__main__":
    main()
