"""A person as a Blender object: one rig, and one painted body for each look the person wears."""

import bpy
from mathutils import Vector

from .pose import JOINTS, REFERENCE_HEIGHT, REST, REST_POSITION
from .wardrobe import dress

RIG_DATA = "person_rig"


def _rig_data():
    """The skeleton every person shares; each person poses its own copy of it."""
    found = bpy.data.armatures.get(RIG_DATA)
    if found:
        return found
    armature = bpy.data.armatures.new(RIG_DATA)
    holder = bpy.data.objects.new("rig_maker", armature)
    bpy.context.scene.collection.objects.link(holder)
    bpy.context.view_layer.objects.active = holder
    bpy.ops.object.mode_set(mode="EDIT")
    for joint in JOINTS:
        bone = armature.edit_bones.new(joint)
        bone.head = REST_POSITION[joint]
        bone.tail = REST_POSITION[joint] + Vector((0, 0, 0.1))
        bone.roll = 0
        if REST[joint][0]:
            bone.parent = armature.edit_bones[REST[joint][0]]
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.data.objects.remove(holder)
    return armature


class Figure:
    def __init__(self, name, identity, looks):
        """looks maps a look id to its garments; the first one is worn until `wear` is called."""
        armature = _rig_data()
        self.rig = bpy.data.objects.new(name, armature)
        bpy.context.scene.collection.objects.link(self.rig)
        self.rig.hide_render = True
        self.scale = identity["height"] / REFERENCE_HEIGHT
        self._bone_frame = armature.bones["hips"].matrix_local.to_3x3()
        self._bone_frame_inverse = self._bone_frame.inverted()
        self.bodies = {}
        for look_id, look in looks.items():
            body = dress(identity, look).build(f"{name}_{look_id}")
            body.parent = self.rig
            body["owner"] = name
            body.modifiers.new("rig", "ARMATURE").object = self.rig
            self.bodies[look_id] = body
        # A new armature object has no pose until the view layer has evaluated it.
        bpy.context.view_layer.update()
        for bone in self.rig.pose.bones:
            bone.rotation_mode = "QUATERNION"

    def wear(self, look_id, shown=True):
        for name, body in self.bodies.items():
            body.hide_render = body.hide_viewport = not (shown and name == look_id)

    def pose(self, solved, placement):
        """Take a solved pose, standing at a placement in the world."""
        self.rig.matrix_world = placement
        for joint in JOINTS:
            self.rig.pose.bones[joint].rotation_quaternion = (self._bone_frame_inverse @ solved.local[joint] @ self._bone_frame).to_quaternion()
        self.rig.pose.bones["hips"].location = self._bone_frame_inverse @ (solved.position["hips"] - REST_POSITION["hips"])
