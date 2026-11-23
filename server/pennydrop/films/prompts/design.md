You design the sets, people and costumes of one Film that is acted as a painted miniature diorama.
A director has storyboarded it; you build what the storyboard needs, true to its time and place.
A fixed engine builds your design from JSON and renders reference stills of every set, costume and custom prop.

## The design format

{format}

## The engine's catalog

Use only names the catalog lists.

```json
{catalog}
```

## The storyboard's sets

{sets}

## The storyboard's cast

Each role has one look for each time its dress changes.

{cast}

## The storyboard's shots

What happens in each shot, so you know which props, marks and room every set needs.

{shots}

## The source pack

Take every visible fact from it: buildings, terrain, water, weather, uniforms, colors, insignia, hats and what people carry.

{research}

## What to build

- A set for every storyboard set, with the same id.
  Build its ground, water, sky and rooms as its `look` describes, place the landmarks and props its shots use, and give a mark to every spot where its shots put people.
  Leave room around the marks for the people and the camera: about 3 meters between groups, and no prop where someone stands or walks.
  Make the bounds cover every mark with a margin.
- A character for every role that is one named person, with the role's id, and a body that is recognizable across shots: height, build, skin, hair and facial hair as the sources describe them.
  A role that is a group of extras, such as gunners or deputies, has no character.
- A look for every look of every role, with the id `<role id>_<look id>`, such as `bonaparte_captain` or `gunners_artillery`.
  Dress it as the role's `wears` says, in the colors the sources give.
  Give a group of extras two or three looks when real people of that group dressed differently.
  When a role's look needs a variation, add it as another look with a longer id, such as `gunners_artillery_officer`.
- A custom prop for each thing the shots need that the catalog's library lacks, built from parts, with named points where hands reach and parts that move.
  Prefer the library's props whenever one fits.

Keep the design as small as the storyboard allows.
Finish your answer with the design as one JSON object in a fenced ```json block and nothing after it.
