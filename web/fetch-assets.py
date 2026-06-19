#!/usr/bin/env python3
"""Fetch the hero icons and map images referenced by the web manifests.

The images themselves are gitignored (see heroes/.gitignore and maps/.gitignore) —
run this after a clone to populate them:

    python3 fetch-assets.py            # fetch anything missing
    python3 fetch-assets.py --force    # re-download everything

Source: the community OverFast API (hero `portrait`, map `screenshot`). The set of
assets to fetch is driven by heroes/heroes.json and maps/maps.json, so adding an
entry there and re-running is all that's needed to pull a new icon.
"""
import argparse
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OVERFAST = "https://overfast-api.tekrop.fr"


def fetch_json(url):
    with urllib.request.urlopen(url) as response:
        return json.load(response)


def manifest_keys(path):
    with open(path) as f:
        return [entry["key"] for entry in json.load(f)]


def sync(name, manifest, out_dir, ext, list_url, image_field, force):
    keys = manifest_keys(manifest)
    images = {item["key"]: item[image_field] for item in fetch_json(list_url)}
    ok = skipped = failed = 0
    for key in keys:
        dest = os.path.join(out_dir, f"{key}.{ext}")
        if not force and os.path.exists(dest):
            skipped += 1
            continue
        url = images.get(key)
        if not url:
            print(f"  {name}: no OverFast entry for '{key}'")
            failed += 1
            continue
        try:
            urllib.request.urlretrieve(url, dest)
            ok += 1
        except Exception as err:  # network / write error — keep going for the rest
            print(f"  {name}: failed '{key}': {err}")
            failed += 1
    print(f"{name}: {ok} fetched, {skipped} skipped, {failed} failed ({len(keys)} total)")
    return failed


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--force", action="store_true",
                        help="re-download even when the file already exists")
    args = parser.parse_args()

    failed = 0
    failed += sync("heroes", os.path.join(HERE, "heroes", "heroes.json"),
                   os.path.join(HERE, "heroes"), "png",
                   f"{OVERFAST}/heroes", "portrait", args.force)
    failed += sync("maps", os.path.join(HERE, "maps", "maps.json"),
                   os.path.join(HERE, "maps"), "jpg",
                   f"{OVERFAST}/maps", "screenshot", args.force)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
