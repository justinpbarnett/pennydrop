from __future__ import annotations

import struct
from dataclasses import dataclass

JPEG_FRAMES = set(range(0xC0, 0xD0)) - {0xC4, 0xC8, 0xCC}
SWAPPED_ORIENTATIONS = {5, 6, 7, 8}


@dataclass(frozen=True)
class ImageShape:
    extension: str
    width: int
    height: int


def image_shape(data: bytes) -> ImageShape | None:
    if data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) >= 24:
        width, height = struct.unpack(">II", data[16:24])
        return ImageShape("png", width, height)
    if data[:3] == b"\xff\xd8\xff":
        return _jpeg_shape(data)
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return _webp_shape(data)
    return None


def _jpeg_shape(data: bytes) -> ImageShape | None:
    position = 2
    orientation = 1
    while position + 4 <= len(data):
        if data[position] != 0xFF:
            return None
        marker = data[position + 1]
        if marker == 0xFF:
            position += 1
            continue
        length = struct.unpack(">H", data[position + 2:position + 4])[0]
        body = data[position + 4:position + 2 + length]
        if marker == 0xE1 and body[:6] == b"Exif\0\0":
            orientation = _exif_orientation(body[6:])
        if marker in JPEG_FRAMES and len(body) >= 5:
            height, width = struct.unpack(">HH", body[1:5])
            return ImageShape("jpg", *((height, width) if orientation in SWAPPED_ORIENTATIONS else (width, height)))
        position += 2 + length
    return None


def _exif_orientation(tiff: bytes) -> int:
    if len(tiff) < 8 or tiff[:2] not in (b"II", b"MM"):
        return 1
    order = "<" if tiff[:2] == b"II" else ">"
    directory = struct.unpack(order + "I", tiff[4:8])[0]
    if directory + 2 > len(tiff):
        return 1
    entries = struct.unpack(order + "H", tiff[directory:directory + 2])[0]
    for index in range(entries):
        start = directory + 2 + 12 * index
        entry = tiff[start:start + 12]
        if len(entry) == 12 and struct.unpack(order + "H", entry[:2])[0] == 0x0112:
            return struct.unpack(order + "H", entry[8:10])[0]
    return 1


def _webp_shape(data: bytes) -> ImageShape | None:
    kind = data[12:16]
    if kind == b"VP8 " and len(data) >= 30:
        width, height = struct.unpack("<HH", data[26:30])
        return ImageShape("webp", width & 0x3FFF, height & 0x3FFF)
    if kind == b"VP8L" and len(data) >= 25:
        bits = struct.unpack("<I", data[21:25])[0]
        return ImageShape("webp", (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1)
    if kind == b"VP8X" and len(data) >= 30:
        return ImageShape("webp", int.from_bytes(data[24:27], "little") + 1, int.from_bytes(data[27:30], "little") + 1)
    return None
