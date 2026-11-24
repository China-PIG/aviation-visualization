#!/usr/bin/env python3
"""Build every offline page in one pass."""
from build_flow import build as build_flow
from build_global import build_global


if __name__ == "__main__":
    build_global()
    build_flow()
