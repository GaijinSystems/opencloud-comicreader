#!/usr/bin/env python3
"""Packs jpg/<comic>/*.jpg into the demo's comics, one per format:

    ../comics/Lanterns of Kestrel Bay #001.cbz   zip
    ../comics/The Quiet Forest #002.cbr          RAR 4 (scripts/rar_writer.py)
    ../comics/Orbit Postal Service #003.cb7      7z: written by build-comics.sh

The 7z ones need the 7z program, so build-comics.sh makes them, in a
container; this script only lays out their files under staging/.
"""
import os
import shutil
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'scripts'))
from rar_writer import write_rar  # noqa: E402

OUT = os.path.join(HERE, '..', 'comics')
COMICS = {
    'kestrel-bay': ('Lanterns of Kestrel Bay', 1),
    'quiet-forest': ('The Quiet Forest', 2),
    'orbit-post': ('Orbit Postal Service', 3),
}


def info(title, number, pages):
    # The spread is the fifth image (index 4).
    return ('<?xml version="1.0" encoding="utf-8"?>\n'
            f'<ComicInfo><Series>{title}</Series><Number>{number}</Number><Title>{title}</Title>'
            "<Summary>A made-up comic for Comic Reader's demo.</Summary>"
            f'<Writer>Demo</Writer><PageCount>{pages}</PageCount>'
            '<Pages><Page Image="4" DoublePage="true"/></Pages></ComicInfo>').encode()


def members(slug, title, number):
    pages = sorted(os.listdir(os.path.join(HERE, 'jpg', slug)))
    files = {'ComicInfo.xml': info(title, number, len(pages))}
    for page in pages:
        with open(os.path.join(HERE, 'jpg', slug, page), 'rb') as handle:
            files[f'{slug}/{page}'] = handle.read()
    return files


os.makedirs(OUT, exist_ok=True)

title, number = COMICS['kestrel-bay']
with zipfile.ZipFile(os.path.join(OUT, f'{title} #{number:03d}.cbz'), 'w', zipfile.ZIP_STORED) as archive:
    for name, data in members('kestrel-bay', title, number).items():
        archive.writestr(name, data)

title, number = COMICS['quiet-forest']
write_rar(os.path.join(OUT, f'{title} #{number:03d}.cbr'), members('quiet-forest', title, number))

title, number = COMICS['orbit-post']
staging = os.path.join(HERE, 'staging', 'orbit-post')
shutil.rmtree(staging, ignore_errors=True)
for name, data in members('orbit-post', title, number).items():
    path = os.path.join(staging, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as handle:
        handle.write(data)
print('packed the zip and the RAR; staged the 7z')
