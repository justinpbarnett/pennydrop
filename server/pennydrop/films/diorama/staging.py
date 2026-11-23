"""From a read design and shot to a built stage: every name resolved, every beat given to its person.

Reading checks the form of a spec; staging checks that what it names exists. Both report to the same reading,
and people get their bodies only when there is nothing to report.
"""

import re

from mathutils import Vector

from . import scenery
from .actions import ACTIONS
from .camera import Camera, Framed, Key
from .effects import EFFECTS
from .format import CAMERA
from .maths import heading_toward, heading_vector, name_seed, rotation_z, scatter
from .performance import (
    BEFORE_THE_SHOT,
    FORMATIONS,
    POINTS,
    Person,
    carry_between,
    handle_span,
)
from .props import PIECE_ACTIONS, PIECES, Piece, build_custom
from .spec import Record, nearest, show
from .stage import Stage
from .wardrobe import extra_identity
from .where import Reference

SOUTH = 180.0
SIDE_TURNS = {"front": 0.0, "left": 90.0, "behind": 180.0, "right": -90.0}
AIM_HEIGHTS = {"wide": 0.5, "full": 0.5, "medium": 0.74, "close": 0.93}
TIME_KEYS = ("at", "cue", "nth", "offset", "verb", "path")


class Shot:
    """A staged shot: the stage, who the shot is about and how big they should be."""

    def __init__(self, stage, subjects, size):
        self.stage, self.subjects, self.size = stage, subjects, size


class Role:
    """One person the shot asks for, before they are placed."""

    def __init__(self, role_id, path, identity, look_ids, place, facing, pose, beats, delay=0.0, offset=(0, 0)):
        self.id, self.path, self.identity, self.look_ids, self.place, self.facing = role_id, path, identity, look_ids, place, facing
        self.pose, self.beats, self.delay, self.offset = pose, beats, delay, Vector(offset)


def _spoken(text):
    return re.sub(r"[^a-z0-9' ]", " ", text.lower()).split()


class Staging:
    def __init__(self, design, shot, words, stage):
        self.design, self.shot, self.stage = design, shot, stage
        self.words = [(spoken[0], word["start"]) for word in words if (spoken := _spoken(word["word"]))]
        self.roles, self.crowds, self._placing, self._carries = {}, {}, [], {}
        self._people_asked_for = {person["id"] or person["character"] for person in shot["people"] if person is not None}

    def _missing(self, thing_id, path, known):
        """Report a name that stands for nothing; a person who could not be cast already has an error saying why."""
        if thing_id not in self._people_asked_for:
            self.fail(path, f"nothing here is called {show(thing_id)}; {nearest(thing_id, known)}")

    def fail(self, path, message):
        return self.stage.reading.fail(path, message)

    # ---- when
    def when(self, item, path, unset=None):
        if item["at"] is None and item["cue"] is None and unset is not None:
            return unset
        if (item["at"] is None) == (item["cue"] is None):
            return self.fail(path, "give exactly one of `at` (seconds into the shot) or `cue` (words the narration speaks in this shot)")
        if item["at"] is not None:
            return item["at"] + item["offset"]
        cue = _spoken(item["cue"])
        spoken = [word for word, start in self.words]
        found = [index for index in range(len(spoken) - len(cue) + 1) if cue and spoken[index : index + len(cue)] == cue]
        if len(found) < item["nth"]:
            times = "is not spoken" if not found else f"is spoken only {len(found)} time(s), so there is no occurrence {item['nth']}"
            return self.fail(f"{path}.cue", f"{show(item['cue'])} {times} in this shot; its words are: {' '.join(spoken) or '(none)'}")
        return self.words[found[item["nth"] - 1]][1] + item["offset"]

    # ---- where
    def _on_ground(self, x, y):
        return Vector((x, y, self.stage.ground.height(x, y)))

    def _thing(self, thing_id):
        if thing_id in self.roles and thing_id not in self.stage.people:
            self._place_person(thing_id)
        return self.stage.thing(thing_id)

    def _known_names(self):
        return [*self.stage.marks, *self.stage.pieces, *self.roles, *self.crowds]

    def aim(self, reference, of_person="head"):
        """A reference as a function of time giving a world point, or None after reporting what it names wrongly."""
        form, value = reference.form, reference.value
        if form == "ground":
            return lambda time: self._on_ground(*value)
        if form == "space":
            return lambda time: Vector(value)
        if form == "camera":
            return lambda time: self.stage.camera.eye(time)
        if form == "beside":
            return self._beside(reference)
        if form == "bearing":
            return self.fail(reference.path, "a bearing is a direction, not a place; name a position or a target here")
        thing_id, parts = value
        point = ".".join(parts)
        if thing_id in self.stage.marks and not parts:
            return lambda time: self._on_ground(*self.stage.marks[thing_id])
        if thing_id in self.crowds:
            return self.fail(reference.path, f"{show(thing_id)} is a crowd; name one member, such as {show(thing_id + '_1')}")
        thing = self._thing(thing_id)
        if thing is None:
            return self._missing(thing_id, reference.path, self._known_names())
        if isinstance(thing, Person):
            if point and point not in POINTS:
                return self.fail(reference.path, f"a person has no point {show(point)}; {nearest(point, POINTS)}")
            return lambda time: thing.point(point or of_person, time)
        if point and point not in thing.point_names():
            return self.fail(reference.path, f"the {thing.kind} {show(thing_id)} has no point {show(point)}; {nearest(point, thing.point_names())}")
        return lambda time: thing.point(point, time)

    def _heading_of(self, reference):
        """The way the thing a reference names faces, as a function of time; south for a bare spot."""
        thing = self.stage.thing(reference.value[0]) if reference.form == "name" else None
        return thing.heading if thing else lambda time: SOUTH

    def _beside(self, reference):
        value = reference.value
        base, heading_at = self.aim(value["beside"], "feet"), self._heading_of(value["beside"])
        if base is None:
            return None

        def beside(time):
            turned = heading_at(time) + SIDE_TURNS[value["side"]]
            spot = base(time) + heading_vector(turned) * value["distance"] + heading_vector(turned - 90) * value["along"]
            return self._on_ground(spot.x, spot.y)

        return beside

    def heading(self, reference, spot_at):
        """A facing as a function of time giving a heading, for someone standing at spot_at(time)."""
        if reference.form == "bearing":
            return lambda time: -reference.value
        target = self.aim(reference, "feet")
        return None if target is None else lambda time: heading_toward(spot_at(time), target(time))

    # ---- the set
    def build_set(self):
        chosen = self.design["sets"].get(self.shot["set"])
        if self.shot["set"] not in self.design["sets"]:
            return self.fail("shot.set", f"the design has no set {show(self.shot['set'])}; {nearest(self.shot['set'], self.design['sets'])}")
        stage = self.stage
        stage.ground = scenery.Ground(chosen["ground"], chosen["water"], chosen["bounds"])
        stage.marks = chosen["marks"]
        for room in chosen["rooms"]:
            scenery.build_room(stage, room)
        for index, placed in enumerate(chosen["pieces"]):
            self._place_piece(placed, f"design.sets.{self.shot['set']}.pieces[{index}]")
        for index, placed in enumerate(self.shot["props"]):
            self._place_piece(placed, f"shot.props[{index}]")
        self.sky = scenery.Sky(stage, scenery.merged_sky(chosen["sky"], self.shot["sky"]))
        return chosen

    def _place_piece(self, placed, path):
        if placed is None:
            return
        if placed["id"] in self.stage.pieces or placed["id"] in self.stage.marks:
            return self.fail(f"{path}.id", f"the id {show(placed['id'])} is already used on this set; give every piece its own id")
        spot_at = self.aim(placed["position"], "feet")
        if spot_at is None:
            return
        spot = spot_at(0.0)
        on_a_point = placed["position"].form == "name" and placed["position"].value[1]
        base = spot.z if on_a_point else self.stage.ground.height(spot.x, spot.y)
        heading_at = self.heading(placed["facing"], lambda time: spot) if placed["facing"] is not None else lambda time: SOUTH
        if heading_at is None:
            return
        custom = self.design["props"].get(placed["kind"])
        piece = Piece(self.stage, placed["id"], placed["kind"], (spot.x, spot.y, base + placed["lift"]), heading_at(0.0) - (180.0 if custom else 0.0))
        if custom:
            build_custom(piece, custom)
        else:
            PIECES[placed["kind"]].make(piece, **{key: value for key, value in placed.items() if key not in ("id", "position", "facing", "lift", "kind")})
        self.stage.pieces[piece.id] = piece

    # ---- the cast
    def _worn(self, first, beats, path):
        """The looks a person needs a body for: the first one and every one a beat changes into."""
        look_ids = [first]
        for index, beat in enumerate(beats):
            if beat and beat["verb"] == "wear" and beat["wear"] not in look_ids:
                look_ids.append(beat["wear"])
        for look_id in look_ids:
            if look_id not in self.design["looks"]:
                self.fail(path, f"the design has no look {show(look_id)}; {nearest(str(look_id), self.design['looks'])}")
                return None
        return look_ids

    def cast(self):
        for index, person in enumerate(self.shot["people"]):
            path = f"shot.people[{index}]"
            if person is None:
                continue
            role_id = person["id"] or person["character"]
            if role_id is None:
                self.fail(path, "a person needs an `id`, or a `character` of the design to take the id from")
                continue
            character = self.design["characters"].get(person["character"]) if person["character"] else None
            if person["character"] and character is None:
                self.fail(f"{path}.character", f"the design has no character {show(person['character'])}; {nearest(person['character'], self.design['characters'])}")
                continue
            first = person["look"] or (character["look"] if character else None)
            if first is None:
                self.fail(path, f"{show(role_id)} has no look; give the person a `look`, or the character a default one")
                continue
            look_ids = self._worn(first, person["beats"], path)
            if look_ids and self._free_id(role_id, path):
                identity = character or extra_identity(name_seed(role_id))
                self.roles[role_id] = Role(role_id, path, identity, look_ids, self._placed_at(person["position"]), person["facing"], person["pose"], person["beats"])
        for index, crowd in enumerate(self.shot["crowds"]):
            if crowd is not None and self._free_id(crowd["id"], f"shot.crowds[{index}]"):
                self._cast_crowd(crowd, f"shot.crowds[{index}]")
        for role_id in list(self.roles):
            self._place_person(role_id)

    def _free_id(self, role_id, path):
        if role_id in self.roles or role_id in self.crowds or role_id in self.stage.pieces or role_id in self.stage.marks:
            self.fail(path, f"the id {show(role_id)} is already used in this shot; give every person, crowd and piece its own id")
            return False
        return True

    def _placed_at(self, position):
        """A person's first place as a function giving (spot, heading or None); a seat brings its own heading."""

        def place():
            spot_at = self.aim(position, "feet")
            if spot_at is None:
                return None
            heading = None
            if position.form == "name" and position.value[1] and position.value[1][0].startswith("seat_"):
                piece = self.stage.pieces[position.value[0]]
                heading = piece.heading(0.0) - piece.front + piece.seats[int(position.value[1][0][5:]) - 1][1]
            return spot_at(0.0), heading

        return place

    def _cast_crowd(self, crowd, path):
        members = [f"{crowd['id']}_{number + 1}" for number in range(crowd["count"])]
        self.crowds[crowd["id"]] = members
        seated = FORMATIONS[crowd["formation"]].facts.get("seated")
        offsets = [(0.0, 0.0)] * crowd["count"] if seated else FORMATIONS[crowd["formation"]].make(crowd["count"], crowd["spacing"], crowd["rows"])
        placed = {}

        def formed():
            """Where the crowd stands and the way it faces, worked out once."""
            if not placed:
                center_at = self.aim(crowd["position"], "feet")
                placed["center"] = center_at(0.0) if center_at else None
                heading_at = self.heading(crowd["facing"], lambda time: placed["center"]) if crowd["facing"] is not None and center_at else None
                placed["heading"] = heading_at(0.0) if heading_at else SOUTH
                placed["seats"] = self._seats(crowd, path) if seated else None
            return placed

        def place(number):
            def member():
                formation = formed()
                if seated:
                    if formation["seats"] is None:
                        return None
                    piece, chosen = formation["seats"]
                    position, heading = piece.seats[chosen[number]]
                    return piece.matrix(0.0) @ position, piece.heading(0.0) - piece.front + heading
                if formation["center"] is None:
                    return None
                turned = rotation_z(formation["heading"]) @ Vector((*offsets[number], 0))
                self.roles[members[number]].offset = turned.to_2d()
                return formation["center"] + turned, formation["heading"]

            return member

        for number, member_id in enumerate(members):
            first = crowd["looks"][number % len(crowd["looks"])]
            look_ids = self._worn(first, crowd["beats"], path)
            if look_ids is None:
                return
            self.roles[member_id] = Role(
                member_id, path, extra_identity(name_seed(member_id)), look_ids, place(number), None, crowd["pose"], crowd["beats"],
                delay=crowd["stagger"] * scatter(number * 3.1 + 1),
            )  # fmt: skip

    def _seats(self, crowd, path):
        """The seating piece a seated crowd names and the seats its members take, spread over all of them."""
        position = crowd["position"]
        piece = self.stage.pieces.get(position.value[0]) if position.form == "name" else None
        if piece is None or not piece.seats:
            seating = [piece_id for piece_id, piece in self.stage.pieces.items() if piece.seats]
            return self.fail(f"{path}.position", f"a seated crowd sits on a piece with seats, named as its position; pieces with seats here: {', '.join(seating) or 'none'}")
        if crowd["count"] > len(piece.seats):
            return self.fail(f"{path}.count", f"{show(position.value[0])} has {len(piece.seats)} seats, too few for {crowd['count']} people; seat at most {len(piece.seats)} or add seats")
        return piece, [int(number * len(piece.seats) / crowd["count"]) for number in range(crowd["count"])]

    def _place_person(self, role_id):
        if role_id in self.stage.people:
            return
        role = self.roles[role_id]
        if role_id in self._placing:
            return self.fail(role.path, f"{show(role_id)} is placed beside someone who is placed beside {show(role_id)}; give one of them a position of their own")
        self._placing.append(role_id)
        placed = role.place()
        self._placing.remove(role_id)
        if placed is None:
            return
        spot, heading = placed
        looks = {look_id: self.design["looks"][look_id] for look_id in role.look_ids}
        person = Person(self.stage, role_id, role.identity, looks, role.look_ids[0], (spot.x, spot.y), SOUTH if heading is None else heading)
        self.stage.people[role_id] = person
        for hand, held in looks[role.look_ids[0]]["hold"].items():
            if held:
                piece = Piece(self.stage, f"{role_id}_{hand}", held["kind"], (0, 0, 0), 0.0)
                PIECES[held["kind"]].make(piece, **{key: value for key, value in held.items() if key != "kind"})
                self.stage.pieces[piece.id] = piece
                person.hold(BEFORE_THE_SHOT, piece, hand)

    # ---- what happens
    def _options(self, given, skip=()):
        """An action's options with what they name resolved: a person, a piece, or a target as a function of time."""
        options, sound = {}, True
        for key, value in given.items():
            if key in skip or key in TIME_KEYS:
                continue
            if isinstance(value, Reference) and value.form in ("person", "prop"):
                found = self.stage.people.get(value.value) if value.form == "person" else self.stage.pieces.get(value.value)
                if found is None:
                    known = self.stage.people if value.form == "person" else self.stage.pieces
                    self.fail(value.path, f"no {value.form} here is called {show(value.value)}; {nearest(value.value, known)}")
                    sound = False
                options[key] = found
            elif isinstance(value, Reference):
                options[key] = self.aim(value)
                sound = sound and options[key] is not None
            else:
                options[key] = value
        return options if sound else None

    def perform(self):
        """Give every person their starting pose and facing, then every beat of the shot in time order."""
        beats = []
        for role in self.roles.values():
            person = self.stage.people.get(role.id)
            if person is None:
                continue
            if role.facing is not None:
                heading_at = self.heading(role.facing, lambda time, person=person: person.spot(time))
                if heading_at:
                    facing = heading_at(0.0)
                    person.face(BEFORE_THE_SHOT, lambda time, facing=facing: facing)
            options = self._options(role.pose, skip=("do",))
            if options is not None:
                person.do(BEFORE_THE_SHOT, role.pose["do"], options)
            for index, beat in enumerate(role.beats):
                time = self.when(beat, beat["path"]) if beat else None
                if time is not None:
                    beats.append((time + role.delay, len(beats), person, role, beat))
        for time, _, person, role, beat in sorted(beats, key=lambda entry: entry[:2]):
            getattr(self, "_beat_" + beat["verb"])(person, role, time, beat)

    def _beat_do(self, person, role, time, beat):
        options = self._options(beat, skip=("do",))
        if options is not None:
            person.do(time, beat["do"], options)

    def _beat_walk(self, person, role, time, beat):
        spots = [self.aim(place, "feet") for place in beat["walk"]]
        own = self._options({key: beat[key] for key in ACTIONS[beat["gait"]].options})
        then = beat["then"] and self._options(beat["then"], skip=("do",))
        if None in spots or own is None or (beat["then"] and then is None):
            return
        spots = [(spot(time) + Vector((*role.offset, 0))).to_2d() for spot in spots]
        person.walk(time, spots, beat["gait"], own, (beat["then"]["do"], then) if beat["then"] else None, beat["seconds"])
        if "end" in own:
            self._carry(person, own["prop"], own["end"], time, beat["path"])

    def _carry(self, person, prop, end, time, path):
        span = handle_span(prop)
        if span is None:
            return self.fail(path, f"the {prop.kind} {show(prop.id)} has no handles to carry it by; carry a stretcher, or use the gait carry_load")
        ends = self._carries.setdefault(prop.id, {})
        ends[end] = person
        if len(ends) == 2:
            front, rear = ends["front"], ends["rear"]
            apart = (front.spot(time) - rear.spot(time)).length
            if abs(apart - span) > 0.3:
                return self.fail(path, f"{show(front.id)} and {show(rear.id)} are {apart:.1f} m apart when they lift {show(prop.id)}, but its handles are {span:.1f} m apart; start them {span:.1f} m apart, one behind the other")
            front.contacts.add(rear.id)
            rear.contacts.add(front.id)
            carry_between(prop, front, rear, time)
            self._carries.pop(prop.id)

    def _beat_face(self, person, role, time, beat):
        heading_at = self.heading(beat["face"], person.spot)
        if heading_at:
            person.face(time, heading_at)

    def _beat_look(self, person, role, time, beat):
        target = None if beat["look"] is False else self.aim(beat["look"])
        if beat["look"] is False or target:
            person.look(time, target)

    def _beat_pose(self, person, role, time, beat):
        person.pose(time, beat["pose"])

    def _beat_reach(self, person, role, time, beat):
        target = self.aim(beat["reach"])
        if target:
            person.reach(time, beat["seconds"], beat["arm"], target)

    def _held_piece(self, person, time, piece_id, path, must_hold):
        piece = self.stage.pieces.get(piece_id)
        if piece is None:
            return self.fail(path, f"no piece here is called {show(piece_id)}; {nearest(piece_id, self.stage.pieces)}")
        if must_hold and person.side_holding(piece, time) is None:
            return self.fail(path, f"{show(person.id)} does not hold {show(piece_id)} at {time:.1f} s; add a `hold` beat before this one, or put it in the look's `hold`")
        return piece

    def _beat_hold(self, person, role, time, beat):
        piece = self._held_piece(person, time, beat["hold"], beat["path"], must_hold=False)
        if piece:
            person.hold(time, piece, beat["hand"])
            self.stage.acts(time, time + 0.4, lambda now: piece.point("", now))

    def _beat_give(self, person, role, time, beat):
        piece = self._held_piece(person, time, beat["give"], beat["path"], must_hold=True)
        receiver = self.stage.people.get(beat["to"])
        if receiver is None:
            return self.fail(f"{beat['path']}.to", f"no person here is called {show(beat['to'])}; {nearest(beat['to'], self.stage.people)}")
        if piece:
            person.give(time, piece, receiver)

    def _beat_drop(self, person, role, time, beat):
        piece = self._held_piece(person, time, beat["drop"], beat["path"], must_hold=True)
        onto = self.aim(beat["onto"]) if beat["onto"] is not None else None
        if piece and (beat["onto"] is None or onto):
            person.drop(time, piece, onto(time) if onto else None)

    def _beat_wear(self, person, role, time, beat):
        person.wear(time, beat["wear"])
        if beat["from"] is None:
            return
        piece = self.stage.pieces.get(beat["from"])
        holder = piece and next((other for other in self.stage.people.values() if other.side_holding(piece, time)), None)
        if holder is None:
            return self.fail(f"{beat['path']}.from", f"nobody holds {show(beat['from'])} at {time:.1f} s; name a held thing, such as one from a look's `hold`")
        holder.put_on(time, piece, person)

    def happen(self):
        for index, event in enumerate(self.shot["events"]):
            time = self.when(event, event["path"]) if event else None
            if time is not None:
                getattr(self, "_event_" + event["verb"])(time, event)

    def _event_prop(self, time, event):
        piece = self.stage.pieces.get(event["prop"])
        if piece is None:
            return self.fail(f"{event['path']}.prop", f"no piece here is called {show(event['prop'])}; {nearest(event['prop'], self.stage.pieces)}")
        if "part" in event:
            part = piece.parts.get(event["part"])
            if part is None:
                return self.fail(f"{event['path']}.part", f"{show(piece.id)} has no part {show(event['part'])}; {nearest(event['part'], piece.parts)}")
            seconds = event.get("seconds", 0.3)
            if event["do"] == "slide":
                part.slide(time, seconds, event["by"])
            elif event["do"] == "rotate":
                part.turn(time, seconds, event["axis"], event["by"])
            elif event["do"] == "glow":
                part.glow(time, seconds, event["color"])
            else:
                part.show(time, event["do"] == "show")
            self.stage.sound(time, event["do"], f"{piece.id}.{event['part']}")
            return self.stage.acts(time, time + seconds, lambda now: part.matrix(now).translation)
        actions = PIECE_ACTIONS.get(piece.kind)
        if actions is None or event["do"] not in actions:
            can = ", ".join(actions.names()) if actions and actions.names() else "nothing of its own; move one of its parts with `part`"
            return self.fail(f"{event['path']}.do", f"a {piece.kind} cannot {show(event['do'])}; it can: {can}")
        entry = actions[event["do"]]
        given = {key: value for key, value in event.items() if key not in TIME_KEYS and key not in ("prop", "do") and value is not None}
        options = Record.read_keys(given, event["path"], self.stage.reading, entry.options)
        options = options and self._options(options)
        if options is None:
            return
        options = {key: value(time) if callable(value) else value for key, value in options.items()}
        seconds = entry.make(piece, time, **options)
        self.stage.sound(time, entry.facts["sound"] or event["do"], piece.id)
        self.stage.acts(time, time + seconds, lambda now: piece.point("", now))

    def _event_effect(self, time, event):
        origin = self.aim(event["position"], "chest")
        if origin is None:
            return
        options = {key: value for key, value in event.items() if key in EFFECTS[event["effect"]].options}
        EFFECTS[event["effect"]].make(self.stage, origin(time), time, **options)
        self.stage.sound(time, event["effect"], "effect")
        self.stage.acts(time, time + 1.5, lambda now: origin(time))

    def _event_sky(self, time, event):
        self.sky.change(time, event["seconds"], event["sky"])
        self.stage.sound(time, "sky", "sky")

    # ---- who it is about, and the camera
    def _member(self, subject):
        """A crowd stands in a shot's subject as the member in its middle."""
        return self.crowds[subject][len(self.crowds[subject]) // 2] if subject in self.crowds else subject

    def subjects(self):
        found = []
        for index, subject in enumerate(self.shot["subject"]):
            thing = self.stage.thing(self._member(subject))
            if thing is None:
                self._missing(subject, f"shot.subject[{index}]", [*self.roles, *self.crowds, *self.stage.pieces])
            else:
                found.append(thing)
        return found

    def _framed(self, reference, size):
        if reference.form == "name" and not reference.value[1]:
            thing = self._thing(reference.value[0])
            if isinstance(thing, Person):
                share = AIM_HEIGHTS[size]
                return Framed(thing.id, lambda time: thing.point("feet", time).lerp(thing.point("head", time), share), thing.height, thing.heading, lambda time: thing.point("feet", time))
            if thing is not None:
                tall = max(thing.size.z, 0.5 * max(thing.size.x, thing.size.y), 0.3)
                return Framed(thing.id, lambda time: thing.point("", time), tall, thing.heading, lambda time: thing.matrix(time).translation)
        point = self.aim(reference)
        if point is None:
            return None
        lift = Vector((0, 0, 0.0 if reference.form == "space" else 0.9))
        return Framed(None, lambda time: point(time) + lift, 1.8, lambda time: SOUTH, lambda time: point(time))

    def film(self):
        subjects = [self._member(subject) for subject in self.shot["subject"]]
        camera = self.shot["camera"] or CAMERA.read({"keys": [{"targets": subjects}]}, "shot.subject", self.stage.reading)
        keys = []
        for index, key in enumerate(camera["keys"]):
            if key is None:
                continue
            time = self.when(key, f"shot.camera.keys[{index}]", unset=0.0)
            size = key["size"] or self.shot["size"]
            framed = [self._framed(target, size) for target in key["targets"]]
            if time is not None and None not in framed:
                keys.append(Key(time, framed, key["bearing"], key["height"], size, key["distance"], key["eye"]))
        focus = self.aim(camera["focus"]) if camera["focus"] is not None else None
        if keys and not self.stage.reading.errors:
            keys.sort(key=lambda key: key.time)
            Camera(self.stage, camera["lens"], keys, focus or (lambda time: self.stage.camera.aim(time)))


def stage_shot(design, shot, words, duration, frames_per_second, reading):
    """Build a shot's whole stage. Returns None, with the reading saying why, when the spec names something wrongly."""
    stage = Stage(reading, frames_per_second, duration)
    staging = Staging(design, shot, words, stage)
    if staging.build_set() is None:
        return None
    staging.cast()
    staging.perform()
    # The camera comes before the events, because an effect may sit on someone who looks at the camera.
    staging.film()
    staging.happen()
    subjects = staging.subjects()
    if reading.errors:
        return None
    for person in stage.people.values():
        person.build()
    return Shot(stage, subjects, shot["size"])
