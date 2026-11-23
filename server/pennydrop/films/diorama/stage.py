"""The stage: everything a shot has built, and how to put it all at one moment of shot time.

Nothing is keyed in Blender. Every moving thing registers an animator, a function of shot time,
and `show` runs them all, so a frame, a still and a staging check see exactly the same world.
"""

import bpy


class Stage:
    def __init__(self, reading, frames_per_second, duration):
        self.reading, self.frames_per_second, self.duration = reading, frames_per_second, duration
        self.ground = None
        self.camera = None
        self.marks, self.pieces, self.people = {}, {}, {}
        self.sounds, self.activity = [], []
        self._animators = []

    def animate(self, animator):
        """Call animator(time) every time the stage is shown."""
        self._animators.append(animator)

    def show(self, time):
        for animator in self._animators:
            animator(time)
        frame = time * self.frames_per_second
        # Stepping the scene clock is what moves the cloth of the flags and settles every matrix for ray casts.
        bpy.context.scene.frame_set(int(frame // 1), subframe=frame % 1)

    def sound(self, time, kind, source):
        """Something a sound mix should know about."""
        self.sounds.append({"time": round(time, 3), "kind": kind, "source": source})

    def acts(self, start, end, where):
        """From start to end something visibly happens at where(time), which keeps the picture alive."""
        self.activity.append((start, end, where))

    def thing(self, thing_id):
        return self.people.get(thing_id) or self.pieces.get(thing_id)
