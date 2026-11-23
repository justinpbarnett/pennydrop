# Diorama design and shot format

A Film is acted by painted miniature people on built sets.
You describe it in two JSON documents: one `design` for the whole Film, and one `shot` for each shot.
A fixed engine reads them, checks them, and renders them.
The engine reports `errors` when a document does not validate, and `problems` when the staging is bad, such as a hidden face or a person walking through a wall.

This page gives the structure and the conventions.
The vocabulary (action names, garments, hats, prop kinds, effects, colors and so on) is not listed here.
It comes from the engine's catalog, which is given to you separately and is always current.
Use only names that appear in the catalog.

## Conventions

- Lengths are meters, times are seconds, angles are degrees.
- `x` points east, `y` points north, `z` points up.
  The ground plane is `[x, y]`.
- A bearing is a compass direction: 0 faces north (+y), 90 faces east (+x), 180 faces south, 270 faces west.
  A person or a piece with no `facing` faces south.
- A color is `"#rrggbb"` or a color name from the catalog.
- An id is lowercase letters, digits and underscores, and is unique within its document.
- Every field not marked required may be left out.
  Leave fields out rather than guessing a value; the defaults are sensible.

### Where: positions

A position is a spot on the ground, written in one of these ways:

- `[x, y]`: ground coordinates.
- `"name"`: a mark of the set, or the id of a prop or a person (the spot where it stands).
- `{"beside": "gun1", "side": "left", "distance": 1.2}`: next to a prop, a person or a mark.
  `side` is `front`, `behind`, `left` or `right`, seen from the thing itself, the way it faces.
  An optional `"along": 0.5` shifts the spot along the thing: at its `left` or `right`, a positive value moves the spot forward and a negative one moves it back.

Prefer marks and `beside` over raw coordinates.
People stand on the ground or floor by themselves; never give a height for a person.

### Toward what: targets

A target is something to face, look at, point at, reach for or aim a camera at:

- any position form above;
- `"id.point"`: a named point of a prop (`"gun1.vent"`, `"cabinet.drawer_7.handle"`) or of a person (`"bonaparte.head"`, `.chest`, `.hips`, `.hand_left`, `.hand_right`, `.shoulder_left`, `.shoulder_right`, `.thigh_left`, `.thigh_right`, `.feet`);
- `[x, y, z]`: a point in space;
- `"camera"`: the camera.

Prefer targets over angles everywhere.
`"facing"` accepts a target or a bearing in degrees.

### When: time

Shot time starts at 0 at the first frame of the shot.
Every beat, event and camera key says when it happens with exactly one of:

- `"at": 2.5`: shot seconds.
  A small negative value is allowed, so that a walk is already under way when the shot opens.
- `"cue": "in charge"`: the moment the narration says that word or phrase.
  The phrase must match consecutive words of the shot's narration; case and punctuation are ignored.
  `"nth": 2` picks the second time the phrase is said.
  `"offset": -0.3` shifts the moment in seconds.

Prefer cues, so the action stays with the voice.
A cue that matches nothing is an error, and the error lists the shot's words.

## Design

```json
{
  "characters": { "<id>": { ... } },
  "looks": { "<id>": { ... } },
  "props": { "<id>": { ... } },
  "sets": { "<id>": { ... } }
}
```

### characters

A character is the identity of a named person, the same in every costume.

| Field | Meaning |
| --- | --- |
| `name` | Display name, used in captions and problem sentences. |
| `height` | Meters. |
| `build` | Body build, from the catalog. |
| `skin` | Color. |
| `hair` | `{"style": ..., "color": ...}`. |
| `facial_hair` | `{"style": ..., "color": ...}`. |
| `glasses` | A glasses style from the catalog. |
| `look` | The look this character wears when a shot names none. |

### looks

A look is a costume, independent of who wears it.
It is an object of garments; each garment is an object with a `color` and its own options.
The catalog lists every garment and its options.
Garments left out are not worn.

`hold` puts catalog items in the hands: `{"right": "musket"}` or `{"left": {"kind": "book", "color": "red"}}`.
A held item gets the id `<person id>_<hand>`, such as `deputy1_right`, which a beat can drop, give away, or put on another person's head.

Topic content, such as one army's uniform, belongs here in the design and nowhere else.

### props

A custom prop is something the topic needs that the catalog's prop library lacks.
It is composed from painted primitive parts.

```json
"card_cabinet": {
  "about": "A cabinet of numbered drawers",
  "parts": [
    {"id": "frame", "shape": "box", "size": [1.6, 0.5, 1.8], "position": [0, 0, 0.9], "color": "walnut", "finish": "wood"},
    {"id": "drawer", "shape": "box", "size": [0.44, 0.46, 0.34], "position": [-0.5, -0.04, 1.5], "color": "oak", "finish": "wood",
     "repeat": {"count": [3, 4], "step": [0.5, 0.4]},
     "points": {"handle": [0, -0.25, 0]}},
    {"id": "label", "parent": "drawer", "shape": "plaque", "size": [0.3, 0.12], "position": [0, -0.235, 0.05], "text": "{n}", "color": "paper"}
  ],
  "points": {"front": [0, -0.9, 0]}
}
```

- The prop's own space has its origin on the ground at the middle of its footprint; its front faces -y, so a prop placed with no `facing` shows its front to the south.
- A part has an `id`, a `shape` (a primitive from the catalog), a `size`, a `position` (the part's center, in the prop's space), an optional `rotation` `[rx, ry, rz]`, a `color` and a `finish`.
- `parent` attaches a part to another part.
  Its `position` is then relative to the parent's center, and it moves with the parent.
- `pivot` is the point a part rotates about, relative to its center.
- `points` are named points, relative to the part's center (inside a part) or in the prop's space (at the top level).
  A person can reach for a point, and a camera can aim at one.
- A `plaque` part carries `text` (short words or numbers) and `text_color`.
- `repeat` copies a part and its children in a grid: `count` is `[columns, rows]` and `step` is `[x step, z step]`.
  The first copy is the top left one, at the part's `position`; copies run left to right, then down.
  The copies get ids `<id>_0`, `<id>_1` and so on (`"first": 1` starts at 1), and `{n}` in a child's `text` becomes that number.
- `solid: false` lets people pass through a part.

A shot moves a part with an event: `slide`, `rotate`, `show`, `hide` or `glow`.

### sets

A set is an environment, built from parameters only.

```json
"harbor_camp": {
  "bounds": [-30, -25, 30, 30],
  "ground": {"height": 6, "cover": "dry_grass", "rough": 0.3, "seed": 3,
             "extent": [-170, -70, 200, 330],
             "features": [{"kind": "hill", "position": [-60, 95], "radius": [26, 16], "height": 10}]},
  "water": [{"kind": "sea", "region": [-170, 58, 200, 150], "level": 0, "shore": 40}],
  "sky": {"time": "day", "sun_bearing": 215, "sun_height": 36, "weather": "clear"},
  "rooms": [],
  "pieces": [{"id": "gun1", "kind": "cannon", "position": [0, 10], "facing": 0}],
  "marks": {"camp": [0, 4]}
}
```

- `bounds` is `[west, south, east, north]`: the acting area.
  A person standing outside it is a problem.
- `ground` is a terrain: a base `height`, a `cover`, a roughness, a `seed`, and `features` from the catalog (hills, plateaus, ridges, valleys, slopes, roads, fields), applied in order.
  A later feature shapes the ground the earlier ones left, so put a `plateau` that people stand on after the hills and slopes around it.
  `extent` is how far the terrain is built, for distant scenery; it defaults to the bounds plus a margin.
- `water` is a list of bodies of water, each with a `kind`, a `level` and a region.
  The engine digs the ground below the water by itself; `shore` is the width of the bank.
  A feature such as a hill inside the water makes an island.
- `sky` has a time of day, the direction the sun or moon stands in (`sun_bearing`, and `sun_height` above the horizon), and the weather.
- `rooms` are interiors.
  A room has an `id`, an `origin` (its south west corner), a `size` `[east-west, north-south, height]`, a `floor` and `walls` (`color`, `finish`).
  Rooms have no ceiling, and the camera looks in like into a doll's house: mark the walls the camera looks through as `"cutaway"` (or `"none"` where a neighbor room's wall already stands), for example `"walls": {"color": "cream", "south": "cutaway"}`.
  `windows` and `doors` are openings in a wall: `{"wall": "north", "offset": 3, "width": 1.2, "height": 2.2}`, where `offset` is the distance from the wall's west or south end to the middle of the opening, and a window also has a `sill` height.
  A door with an `id` gets a door leaf that a shot can open and close.
- `pieces` are props and set pieces from the catalog's library, or custom props of the design, placed with an `id`, a `kind`, a `position`, a `facing` and the kind's own options.
  `lift` raises a piece above the ground, for a thing on a table or a wall.
  The `spread` of a town or a group of trees is its half-extent each way, so `"spread": [10, 6]` covers 20 by 12 meters around the position.
  Keep scattered pieces clear of the marks and of the line from the camera to the action.
- `marks` are named spots.
  Give every place where people stand or walk to a mark.

## Shot

```json
{
  "set": "harbor_camp",
  "sky": {"sun_bearing": 150},
  "subject": ["bonaparte"],
  "size": "full",
  "props": [ ... ],
  "people": [ ... ],
  "crowds": [ ... ],
  "events": [ ... ],
  "camera": { ... }
}
```

- `set` (required) names a set of the design.
- `sky` overrides fields of the set's sky for this shot.
- `subject` (required) lists who or what the shot is about: ids of people, or of props when the shot is about a thing or a place.
- `size` (required) is the shot size, from the catalog: how big the subject is in the frame.
- The checks hold the subject to both: in frame, not hidden, face visible, big enough.
- `props` are extra pieces for this shot only, in the same form as a set's `pieces`.

### people

```json
{
  "id": "bonaparte",
  "character": "bonaparte",
  "look": "captain",
  "position": {"beside": "gun1", "side": "left", "distance": 1.0},
  "facing": "deputy1",
  "pose": "at_ease",
  "beats": [
    {"cue": "Captain Bonaparte", "walk": "front_mark", "gait": "stride", "then": "attention"},
    {"cue": "in charge", "do": "salute"},
    {"cue": "guns", "offset": 0.3, "face": "gun1"}
  ]
}
```

- `character` names a character of the design.
  Without it the person is an extra, whose face and height the engine varies by itself; an extra needs an `id` and a `look`.
- `position` (required) and `facing` are where the person starts.
- `pose` is the action the person starts in: a name, or an object with the action's options, such as `{"do": "offer", "height": 1.2}`.
- `beats` are what the person does, each with a time and exactly one of these verbs:

| Verb | Meaning |
| --- | --- |
| `"do": "<action>"` | Perform an action from the catalog, with the action's own options, such as `target` and `arm`. A pose or a loop lasts until the person's next `do` or `walk`; a gesture plays once and returns to what came before. |
| `"walk": <position>` | Walk there, or along a list of positions. `gait` is how (from the catalog), `then` is the action to end in. The engine times the walk from the gait's speed; `seconds` sets the time instead, and a walk faster than the gait allows is reported as a problem. |
| `"face": <target>` | Turn the whole body toward a target or a bearing. |
| `"look": <target>` | Turn only the head; `null` lets go. |
| `"pose": { ... }` | A custom pose as joint angles (names in the catalog), held until the next `do` or `walk`. |
| `"reach": <target>` | Put a hand on a target (`arm`: `left` or `right`), for `seconds`. The hand takes about half a second to arrive and half a second to return, so give a reach more than a second. |
| `"hold": "<prop id>"` | Take a prop into a hand (`hand`: `left` or `right`). |
| `"give": "<prop id>"` | Hand a held prop to the person named in `to`. |
| `"drop": "<prop id>"` | Let go of a held prop; `onto` is a target to put it on. |
| `"wear": "<look>"` | Change into another look at that instant. With `"from": "<held item id>"`, the person holding that item reaches over and puts it on this person's head as the look changes, for a hat or a crown. |

Actions that touch someone or something (carrying together, lying on a litter, an embrace, a struggle, a blow) name the other side in `partner` or `prop`; the engine then makes the hands grip and lets the bodies touch.
Two people who carry one thing start a handle span apart, at the thing's two ends.
An arm on the far side of the body from the camera is hidden by the body, so reach, point and offer with the arm nearer the camera.

### crowds

```json
{
  "id": "column",
  "looks": ["infantry", "infantry", "gunner"],
  "count": 12,
  "formation": "column",
  "position": "road_start",
  "facing": "gate",
  "spacing": 1.4,
  "pose": "shoulder_arms",
  "beats": [{"cue": "marches", "walk": "gate", "gait": "march"}]
}
```

A crowd is many extras directed as one.
`looks` is the mix of looks, `formation` comes from the catalog, and `position` is the middle of the formation.
`rows` is the number of rows in a `block` or in `ranks`.
The `seated` formation takes the id of a piece with seats, such as benches, as its `position` and spreads the crowd over the seats.
Every member performs the beats, each a little earlier or later and from its own place in the formation.
`stagger`, in seconds, is that spread; it is a key of the crowd, not of a beat.
Member ids are `<crowd id>_1`, `<crowd id>_2` and so on, and can be used as targets.

### events

An event is something that happens to a thing rather than to a person.
Each has a time and one of these forms:

- `{"prop": "gun1", "do": "fire"}`: an action of a library prop, from the catalog.
- `{"prop": "cabinet", "part": "drawer_7", "do": "slide", "by": [0, -0.35, 0], "seconds": 0.8}`: move a part of a prop.
  `slide` moves it `by` an offset, `rotate` turns it `by` degrees about `axis` (`x`, `y` or `z`) at its pivot, `show` and `hide` switch it, `glow` lights it in a `color`.
- `{"effect": "puff", "position": "gun1.muzzle", "size": 1.0}`: an effect from the catalog at a target.
- `{"sky": {"time": "day", "weather": "clear"}, "seconds": 1.5}`: change the sky during the shot.

### camera

```json
"camera": {
  "lens": 40,
  "focus": "bonaparte",
  "keys": [
    {"at": 0, "targets": ["bonaparte", "deputy1"], "bearing": 30, "height": 1.6, "size": "full"},
    {"cue": "guns", "targets": ["bonaparte"], "bearing": 15, "height": 1.5, "size": "medium"}
  ]
}
```

- `lens` is the focal length in millimeters (full frame), and `focus` is the target kept sharp; it defaults to the first target.
- A key frames its `targets` (people, props, marks or other targets).
- `bearing` is where the camera stands, relative to the way the first target faces: 0 is straight in front, looking at the face; 90 is at the target's right side; 180 is behind; 270 is at the left side.
  For a target that faces nowhere, such as a mark, it is a compass bearing from the target.
- `height` is the camera's height above the ground under the first target.
- `size` is the key's shot size; it defaults to the shot's `size`.
  The engine computes the `distance` from the lens and the size so the targets fill the frame right; give `distance` only to override it.
- `eye` `[x, y, z]` places the camera at an explicit point instead of bearing, height and distance.
  The engine does not move an explicit eye; it aims at the middle of the targets and keeps tracking them as they move.
  A target written as `[x, y, z]` is a fixed point in space.
- A person who faces away from the camera while acting is a problem.
  Turn the person, move the camera to the side they face, or give the person `"look": "camera"` so the face stays in view.
- A shot about a place can name a prop as its `subject`, with people seen from behind in the foreground.
- The camera eases from key to key, follows its targets when they move, keeps a small handheld drift, and never rolls.
  The engine pulls a camera in when a wall or a building stands between it and its targets.
- The first key should be at time 0.
  One key is enough for a steady shot.

## A complete small example

Design:

```json
{
  "characters": {
    "clerk": {"name": "The clerk", "height": 1.72, "build": "slight", "skin": "#d9a77c",
              "hair": {"style": "short", "color": "#3b2617"}, "glasses": "round", "look": "office"}
  },
  "looks": {
    "office": {
      "shirt": {"color": "white"},
      "waistcoat": {"color": "#5b6770"},
      "legs": {"kind": "trousers", "color": "#2d3138"},
      "shoes": {"color": "black"}
    }
  },
  "props": {
    "card_cabinet": {
      "about": "A cabinet of numbered drawers",
      "parts": [
        {"id": "frame", "shape": "box", "size": [1.6, 0.5, 1.8], "position": [0, 0, 0.9], "color": "walnut", "finish": "wood"},
        {"id": "drawer", "shape": "box", "size": [0.44, 0.46, 0.34], "position": [-0.5, -0.04, 1.5], "color": "oak", "finish": "wood",
         "repeat": {"count": [3, 4], "step": [0.5, 0.4]},
         "points": {"handle": [0, -0.25, 0]}},
        {"id": "label", "parent": "drawer", "shape": "plaque", "size": [0.3, 0.12], "position": [0, -0.235, 0.05], "text": "{n}", "color": "paper"}
      ]
    }
  },
  "sets": {
    "archive": {
      "bounds": [0, 0, 8, 5],
      "ground": {"height": 0, "cover": "paved"},
      "sky": {"time": "day", "sun_bearing": 160, "sun_height": 55},
      "rooms": [{"id": "office", "origin": [0, 0], "size": [8, 5, 3.2],
                 "floor": {"color": "#8a6a4a", "finish": "wood"},
                 "walls": {"color": "cream", "south": "cutaway"},
                 "doors": [{"id": "door", "wall": "east", "offset": 2.5, "width": 1.0, "height": 2.1}]}],
      "pieces": [{"id": "cabinet", "kind": "card_cabinet", "position": [3, 4.6]}],
      "marks": {"entry": [0.8, 3.75], "at_cabinet": [2.85, 3.75], "at_door": [7.2, 2.5]}
    }
  }
}
```

Shot, for the narration "The clerk opens drawer seven and takes the card to the next room":

```json
{
  "set": "archive",
  "subject": ["clerk"],
  "size": "full",
  "people": [
    {"character": "clerk", "position": "entry", "facing": 90, "pose": "stand",
     "beats": [
       {"at": 0.2, "walk": "at_cabinet", "gait": "walk", "then": "stand"},
       {"cue": "opens", "reach": "cabinet.drawer_7.handle", "arm": "left", "seconds": 1.2},
       {"cue": "takes", "do": "read"},
       {"cue": "next room", "walk": "at_door", "gait": "walk", "then": "stand"}
     ]}
  ],
  "events": [
    {"cue": "opens", "offset": 0.3, "prop": "cabinet", "part": "drawer_7", "do": "slide", "by": [0, -0.3, 0], "seconds": 0.7},
    {"cue": "next room", "offset": 0.8, "prop": "door", "do": "open"}
  ],
  "camera": {
    "lens": 35,
    "keys": [
      {"at": 0, "eye": [3.0, -2.6, 1.8], "targets": ["clerk"]},
      {"cue": "next room", "offset": 2.0, "eye": [5.5, -2.6, 1.8], "targets": ["clerk"]}
    ]
  }
}
```

The clerk walks east along the cabinet and reaches with the arm nearer to it, so the camera in the open south side sees his face in profile all the way.

## What the engine reports back

- `errors`: the document is wrong, and nothing was built.
  Each names the JSON path, what is wrong, and what would be right.
  Fix every one.
- `problems`: the shot built, but the staging is bad.
  Each is one sentence saying who, what, when, and usually how to fix it.
  Fix every one, most often by moving a person, a mark or the camera.
  The staging is checked in a preview only, never in a final render.
- `stills`: pictures of the shot at its key moments, with captions.
  Look at them; a shot with no problems can still be dull or unclear.
  A preview takes at most 6 still times; without any, the engine picks the moments just after things happen.
  A sheet of the design gives one still for each character, look, custom prop and set, each with `time` 0.
