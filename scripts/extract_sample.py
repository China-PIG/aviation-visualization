#!/usr/bin/env python3
"""Extract the January 2015 domestic sample from the Zenodo archive."""
import argparse
import csv
import gzip
import io
import json
import re
from collections import Counter
from datetime import date, timedelta
from pathlib import Path
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
HUBS = ("CAN", "PEK", "PVG", "SHA", "SZX")
START, END = "2015-01-01", "2015-01-31"
CLOCK = re.compile(r"(?:[01]\d|2[0-3]):[0-5]\d\Z")
HEADER = ("source", "date", "origin", "destination", "scheduled", "state")


def select_rows(sources, airport_codes):
    """Prefer the origin's export when both ends have a source file."""
    counts = Counter()
    expected_days = {str(date.fromisoformat(START) + timedelta(days=i)) for i in range(31)}
    for source, lines in sources:
        days = set()
        for row in csv.reader(lines):
            if len(row) < 12:
                continue
            day, origin, destination, status = (value.strip() for value in row[2:6])
            if not START <= day <= END:
                continue
            days.add(day)
            if origin == destination or origin not in airport_codes or destination not in airport_codes:
                continue
            chosen = origin if origin in HUBS else destination
            if source != chosen:
                counts["excluded_other_airport_export"] += 1
                continue
            scheduled = row[7].strip()
            if not CLOCK.fullmatch(scheduled):
                counts["missing_scheduled"] += 1
                continue
            if status == "取消":
                state = "cancelled"
            elif CLOCK.fullmatch(row[11].strip()) and row[10].strip() not in ("", "NULL"):
                state = "operated"
            else:
                state = "unknown"
            counts[state] += 1
            yield (source, day, origin, destination, scheduled, state)
        if days != expected_days:
            raise ValueError(f"{source} 日期不完整，缺少 {sorted(expected_days - days)}")
    print(dict(counts))


def archive_rows(path):
    with ZipFile(path) as archive:
        for hub in HUBS:
            name = f"{hub.lower()}_data_202601.txt"
            with archive.open(name) as source:
                yield hub, io.TextIOWrapper(source, encoding="utf-8-sig")


def write_sample(sources):
    airport_codes = {a["code"] for a in json.loads((DATA / "airports.json").read_text(encoding="utf-8"))}
    rows = list(select_rows(sources, airport_codes))
    with gzip.open(DATA / "flight-sample.csv.gz", "wt", newline="", encoding="utf-8") as output:
        writer = csv.writer(output)
        writer.writerow(HEADER)
        writer.writerows(rows)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path, help="Zenodo 原始 ZIP 文件")
    write_sample(archive_rows(parser.parse_args().archive))
