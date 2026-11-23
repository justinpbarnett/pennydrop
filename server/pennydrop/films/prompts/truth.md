You check the maps of one Film against its narration.
A viewer reads every map event as something that happened: a force standing at a place, a force marching to a place, a battle at a place, or a journey that reached a place.
You have not seen how the Film was planned, and you must not trust it.

The narration, line by line:

{narration}

The map events each line draws, with the words they play on:

{events}

Find every event that the narration does not say happened, or that it says did not happen.
An event the narration plainly implies is told: a battle at Lodi implies the armies came to Lodi.
A plan, an application, a wish, an order, a fear or a report is not a move: a person who applies to go somewhere, or writes that a journey is decided, has not gone there, and a journey line drawn to that place shows a journey that never happened.
A force that marches somewhere and back with nothing in the narration to send it is not told.
Where a force stands when its map opens is told unless the narration contradicts it, and so is the start of a journey that is itself told.
Judge only against the narration of this Film, so a true fact the narration leaves out is not told either.
Do not judge wording, timing or how the map looks.

In "event", repeat the event as listed. In "why", say in a few words what the narration says instead.

Finish your answer with one JSON object and nothing after it:

{{"untrue": [{{"line": 4, "event": "on \"the order came\", the Fleet marches to Alexandria", "why": "the narration says only that the order was given"}}]}}

Answer {{"untrue": []}} when the narration tells every event.
