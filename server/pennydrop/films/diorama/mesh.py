"""Building meshes from painted primitives."""

import itertools
import math

import bmesh
import bpy
from mathutils import Vector

from .maths import frame_toward, placement


class MeshBuilder:
    """Collects primitives into one mesh; each primitive has a material and may follow a bone."""

    def __init__(self):
        self.vertices, self.faces, self.face_materials, self.vertex_bones, self.materials = [], [], [], [], []

    def is_empty(self):
        return not self.faces

    def _material_index(self, material):
        if material not in self.materials:
            self.materials.append(material)
        return self.materials.index(material)

    def add(self, vertices, faces, material, bone=None, transform=None):
        first = len(self.vertices)
        index = self._material_index(material)
        for vertex in vertices:
            vertex = Vector(vertex)
            self.vertices.append(tuple(transform @ vertex) if transform is not None else tuple(vertex))
            self.vertex_bones.append(bone)
        for face in faces:
            self.faces.append(tuple(corner + first for corner in face))
            self.face_materials.append(index)

    def merge(self, other, transform=None, bone=None):
        """Take over another builder's primitives, moved by transform; bone replaces their bones when given."""
        first = len(self.vertices)
        for vertex, vertex_bone in zip(other.vertices, other.vertex_bones):
            self.vertices.append(tuple(transform @ Vector(vertex)) if transform is not None else vertex)
            self.vertex_bones.append(bone or vertex_bone)
        for face, index in zip(other.faces, other.face_materials):
            self.faces.append(tuple(corner + first for corner in face))
            self.face_materials.append(self._material_index(other.materials[index]))

    def revolve(self, profile, material, bone=None, transform=None, squash=(1.0, 1.0), segments=14, capped=True, sweep=360.0):
        """A surface of revolution about local z from [(radius, height)]; sweep under 360 leaves it open, centered on +y."""
        closed = sweep >= 360.0
        columns = segments if closed else segments + 1
        vertices, faces, rings = [], [], []
        for radius, height in profile:
            if radius < 1e-6:
                rings.append([len(vertices)])
                vertices.append((0, 0, height))
                continue
            rings.append(list(range(len(vertices), len(vertices) + columns)))
            for column in range(columns):
                angle = math.radians(90 - sweep / 2 + sweep * column / segments) if not closed else 2 * math.pi * column / segments
                vertices.append((radius * squash[0] * math.cos(angle), radius * squash[1] * math.sin(angle), height))
        for lower, upper in itertools.pairwise(rings):
            if len(lower) == 1 and len(upper) == 1:
                continue
            for column in range(segments):
                following = (column + 1) % columns
                if len(lower) == 1:
                    faces.append((lower[0], upper[following], upper[column]))
                elif len(upper) == 1:
                    faces.append((lower[column], lower[following], upper[0]))
                else:
                    faces.append((lower[column], lower[following], upper[following], upper[column]))
        if capped and closed:
            if len(rings[0]) > 1:
                faces.append(tuple(reversed(rings[0])))
            if len(rings[-1]) > 1:
                faces.append(tuple(rings[-1]))
        self.add(vertices, faces, material, bone, transform)

    def capsule(self, start, end, start_radius, end_radius=None, material=None, bone=None, squash=(1.0, 1.0), segments=12, rings=4):
        end_radius = start_radius if end_radius is None else end_radius
        length = (Vector(end) - Vector(start)).length
        profile = [(start_radius * math.cos(math.radians(-90 + 90 * ring / rings)), start_radius * math.sin(math.radians(-90 + 90 * ring / rings))) for ring in range(rings + 1)]
        profile += [(end_radius * math.cos(math.radians(90 * ring / rings)), length + end_radius * math.sin(math.radians(90 * ring / rings))) for ring in range(rings + 1)]
        self.revolve(profile, material, bone, frame_toward(start, end), squash, segments)

    def ball(self, center, radius, material, bone=None, scale=1.0, rotation=None, segments=14, rings=7):
        profile = [(radius * math.cos(math.radians(-90 + 180 * ring / rings)), radius * math.sin(math.radians(-90 + 180 * ring / rings))) for ring in range(rings + 1)]
        self.revolve(profile, material, bone, placement(center, rotation, scale), segments=segments)

    def dome(self, center, radius, material, bone=None, scale=1.0, rotation=None, segments=14, rings=5, reach=90.0):
        """The top of a ball, closed underneath; reach is degrees down from the pole."""
        profile = [(radius * math.sin(math.radians(reach * (1 - ring / rings))), radius * math.cos(math.radians(reach * (1 - ring / rings)))) for ring in range(rings + 1)]
        self.revolve(profile, material, bone, placement(center, rotation, scale), segments=segments)

    def cylinder(self, start, end, start_radius, end_radius=None, material=None, bone=None, segments=12, squash=(1.0, 1.0)):
        end_radius = start_radius if end_radius is None else end_radius
        length = (Vector(end) - Vector(start)).length
        self.revolve([(start_radius, 0), (end_radius, length)], material, bone, frame_toward(start, end), squash, segments)

    def box(self, center, size, material, bone=None, rotation=None, taper=(1.0, 1.0), transform=None):
        half_x, half_y, half_z = size[0] / 2, size[1] / 2, size[2] / 2
        top_x, top_y = half_x * taper[0], half_y * taper[1]
        vertices = [(-half_x, -half_y, -half_z), (half_x, -half_y, -half_z), (half_x, half_y, -half_z), (-half_x, half_y, -half_z),
                    (-top_x, -top_y, half_z), (top_x, -top_y, half_z), (top_x, top_y, half_z), (-top_x, top_y, half_z)]  # fmt: skip
        faces = [(3, 2, 1, 0), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
        local = placement(center, rotation)
        self.add(vertices, faces, material, bone, (transform @ local) if transform is not None else local)

    def roof(self, center, size, material, rotation=None, transform=None):
        """A pitched roof: ridge along local x, base size (x, y), height z, standing on center."""
        half_x, half_y, height = size[0] / 2, size[1] / 2, size[2]
        vertices = [(-half_x, -half_y, 0), (half_x, -half_y, 0), (half_x, half_y, 0), (-half_x, half_y, 0), (-half_x, 0, height), (half_x, 0, height)]
        faces = [(3, 2, 1, 0), (0, 1, 5, 4), (2, 3, 4, 5), (1, 2, 5), (3, 0, 4)]
        local = placement(center, rotation)
        self.add(vertices, faces, material, None, (transform @ local) if transform is not None else local)

    def sheet(self, corner, across, up, material, columns=1, rows=1, bulge=0.0, transform=None):
        """A flat or bellied rectangle of cloth or paper from a corner along two edge vectors."""
        corner, across, up = Vector(corner), Vector(across), Vector(up)
        outward = across.cross(up).normalized()
        vertices = []
        for column in range(columns + 1):
            for row in range(rows + 1):
                along, upward = column / columns, row / rows
                vertices.append(corner + across * along + up * upward + outward * bulge * math.sin(math.pi * along) * math.sin(math.pi * upward))
        faces = []
        for column in range(columns):
            for row in range(rows):
                first = column * (rows + 1) + row
                faces.append((first, first + rows + 1, first + rows + 2, first + 1))
        self.add(vertices, faces, material, None, transform)

    def build(self, name, collection=None, sharp=38.0, bevel=0.0, weld=False):
        data = bpy.data.meshes.new(name)
        data.from_pydata(self.vertices, [], self.faces)
        for material in self.materials:
            data.materials.append(material)
        data.polygons.foreach_set("material_index", self.face_materials)
        data.polygons.foreach_set("use_smooth", [True] * len(self.faces))
        working = bmesh.new()
        working.from_mesh(data)
        if weld:
            bmesh.ops.remove_doubles(working, verts=working.verts, dist=1e-4)
        bmesh.ops.recalc_face_normals(working, faces=working.faces)
        working.to_mesh(data)
        working.free()
        data.set_sharp_from_angle(angle=math.radians(sharp))
        data.update()
        made = bpy.data.objects.new(name, data)
        (collection or bpy.context.scene.collection).objects.link(made)
        if not weld:
            groups = {}
            for index, bone in enumerate(self.vertex_bones):
                if bone:
                    groups.setdefault(bone, []).append(index)
            for bone, indices in groups.items():
                made.vertex_groups.new(name=bone).add(indices, 1.0, "REPLACE")
        if bevel:
            modifier = made.modifiers.new("bevel", "BEVEL")
            modifier.width, modifier.segments = bevel, 2
            modifier.limit_method, modifier.angle_limit = "ANGLE", math.radians(40)
            modifier.harden_normals = False
        return made


def collection(name):
    """A named collection in the scene, made on first use."""
    found = bpy.data.collections.get(name)
    if found is None:
        found = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(found)
    return found


def new_empty(name, location=(0, 0, 0)):
    made = bpy.data.objects.new(name, None)
    made.location = location
    bpy.context.scene.collection.objects.link(made)
    return made
