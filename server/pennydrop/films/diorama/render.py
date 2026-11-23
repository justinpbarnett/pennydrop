"""The Blender scene a stage is built into, and pictures of a stage at chosen times."""

import bpy

from .effects import forget_shapes
from .paint import forget_materials

PREVIEW_SIZE = (960, 540)
PREVIEW_SAMPLES = 8
FINAL_SAMPLES = 32


def fresh_scene(size, samples, frames_per_second):
    """Empty Blender and set the scene up for EEVEE; everything built before this is gone."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    forget_materials()
    forget_shapes()
    scene = bpy.context.scene
    render = scene.render
    render.engine = "BLENDER_EEVEE"
    render.resolution_x, render.resolution_y, render.resolution_percentage = int(size[0]), int(size[1]), 100
    render.fps = frames_per_second
    render.image_settings.file_format, render.image_settings.color_mode, render.image_settings.compression = "PNG", "RGB", 30
    render.film_transparent = False
    eevee = scene.eevee
    eevee.taa_render_samples = samples
    eevee.use_shadows = True
    eevee.shadow_ray_count, eevee.shadow_step_count = 2, 6
    eevee.use_raytracing = True
    eevee.ray_tracing_method = "SCREEN"
    eevee.ray_tracing_options.resolution_scale = "2"
    eevee.ray_tracing_options.trace_max_roughness = 0.3
    eevee.use_fast_gi = True
    eevee.fast_gi_method = "AMBIENT_OCCLUSION_ONLY"
    eevee.fast_gi_distance = 1.2
    eevee.bokeh_max_size = 60
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"


def picture(stage, time, path):
    """Render the stage as it is at a time into a PNG."""
    stage.show(time)
    bpy.context.scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
