import math
from pathlib import Path

from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont
from fontTools.ttLib.removeOverlaps import removeOverlaps

FAMILY = "Pennydrop Mark"
POSTSCRIPT = "PennydropMark-Regular"
SLASH_WIDTH = 80
SLASH_ANGLES = (235, 55)
FLAG_REACH = (-88, -70)
CAP_CURVE = 20 / 48


def ring_middle(bounds_outer, bounds_inner, degrees):
    center_x = (bounds_outer[0] + bounds_outer[2]) / 2
    center_y = (bounds_outer[1] + bounds_outer[3]) / 2
    radius_x = ((bounds_outer[2] - bounds_outer[0]) + (bounds_inner[2] - bounds_inner[0])) / 4
    radius_y = ((bounds_outer[3] - bounds_outer[1]) + (bounds_inner[3] - bounds_inner[1])) / 4
    angle = math.radians(degrees)
    return center_x + radius_x * math.cos(angle), center_y + radius_y * math.sin(angle)


def contour_bounds(points):
    xs = [x for x, _ in points]
    ys = [y for _, y in points]
    return min(xs), min(ys), max(xs), max(ys)


def slashed_zero(font):
    glyphs = font.getGlyphSet()
    recording = DecomposingRecordingPen(glyphs)
    glyphs["zero"].draw(recording)
    contours = [[point for point in args if point is not None] for op, args in recording.value if op != "closePath"]
    outer, inner = sorted((contour_bounds(points) for points in contours), key=lambda box: box[0])
    start = ring_middle(outer, inner, SLASH_ANGLES[0])
    end = ring_middle(outer, inner, SLASH_ANGLES[1])
    length = math.dist(start, end)
    normal = (-(end[1] - start[1]) / length * SLASH_WIDTH / 2, (end[0] - start[0]) / length * SLASH_WIDTH / 2)
    corners = [(start[0] + normal[0], start[1] + normal[1]), (end[0] + normal[0], end[1] + normal[1]),
               (end[0] - normal[0], end[1] - normal[1]), (start[0] - normal[0], start[1] - normal[1])]
    pen = TTGlyphPen(glyphs)
    recording.replay(pen)
    pen.moveTo(tuple(round(value) for value in corners[0]))
    for corner in corners[1:]:
        pen.lineTo(tuple(round(value) for value in corner))
    pen.closePath()
    return pen.glyph()


def capsule(pen, start, end, radius):
    length = math.dist(start, end)
    along = ((end[0] - start[0]) / length, (end[1] - start[1]) / length)
    across = (along[1], -along[0])

    def at(center, side, forward):
        return tuple(round(center[axis] + radius * (side * across[axis] + forward * along[axis])) for axis in (0, 1))

    pen.moveTo(at(start, 1, 0))
    pen.lineTo(at(end, 1, 0))
    pen.qCurveTo(at(end, 1, CAP_CURVE), at(end, CAP_CURVE, 1), at(end, -CAP_CURVE, 1), at(end, -1, CAP_CURVE), at(end, -1, 0))
    pen.lineTo(at(start, -1, 0))
    pen.qCurveTo(at(start, -1, -CAP_CURVE), at(start, -CAP_CURVE, -1), at(start, CAP_CURVE, -1), at(start, 1, -CAP_CURVE), at(start, 1, 0))
    pen.closePath()


def flagged_one(font):
    glyphs = font.getGlyphSet()
    recording = DecomposingRecordingPen(glyphs)
    glyphs["one"].draw(recording)
    stem = [point for op, args in recording.value if op != "closePath" for point in args if point is not None]
    left, bottom, right, top = contour_bounds(stem)
    radius = (right - left) / 2
    tip = ((left + right) / 2, top - radius)
    pen = TTGlyphPen(glyphs)
    recording.replay(pen)
    capsule(pen, tip, (tip[0] + FLAG_REACH[0], tip[1] + FLAG_REACH[1]), radius)
    return pen.glyph()


def rename(font):
    names = font["name"]
    for record in list(names.names):
        if record.nameID in (1, 16):
            record.string = FAMILY
        elif record.nameID in (2, 17):
            record.string = "Regular"
        elif record.nameID == 4:
            record.string = f"{FAMILY} Regular"
        elif record.nameID == 6:
            record.string = POSTSCRIPT
        elif record.nameID == 3:
            record.string = f"{POSTSCRIPT};derived from Routed Gothic with a slashed zero and a flagged one"


FONTS = Path(__file__).resolve().parent.parent / "public" / "fonts" / "pattern"
source, target = FONTS / "routed-gothic.woff2", FONTS / "pennydrop-mark.woff2"
font = TTFont(source)
font["glyf"]["zero"] = slashed_zero(font)
font["glyf"]["one"] = flagged_one(font)
removeOverlaps(font, ["zero", "one"])
rename(font)
font.flavor = "woff2"
font.save(target)
print(target, target.stat().st_size)
