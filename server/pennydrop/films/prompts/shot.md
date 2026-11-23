You stage one shot of a Film that is acted as a painted miniature diorama: small people in the dress of their time, on built sets, filmed by a moving camera under a narrator's voice.
You write the shot as JSON for a fixed engine, which checks it, builds it, and renders it.

## The format

{format}

## The engine's catalog

Use only names the catalog lists.

```json
{catalog}
```

## The Film's design

The sets, characters, costumes and custom props you stage with.
Each storyboard role wears the look `<role id>_<look id>`, and a role that is one named person is the character with the role's id.

```json
{design}
```

## The storyboard

The whole Film, shot by shot, so you know where this shot sits:

{overview}

## This shot

{board}

It runs {seconds} seconds, and the narrator says these words during it, at these shot times:

{words}

{previous}

{following}

## How to stage it

- The people act what the narration says while it says it: put each beat on the cue of the words it acts.
  Something acts in view at every moment: when nobody has a beat, someone gestures, talks, works, walks or reacts.
- Do what the storyboard's action and camera say, and make the viewer understand what its `shows` says.
- Keep the subject big enough for the shot size, with the face toward the camera, and nobody standing between them and the camera.
- Place people on the set's marks and beside its pieces, and keep them clear of each other and of walls, props and water.
- Match the shot before it: the same people stand where they stood and face the way they faced, unless the narration moves them.
- Give a crowd enough members to read as the group it is, and no more than the shot needs.

Finish your answer with the shot as one JSON object in a fenced ```json block and nothing after it.
