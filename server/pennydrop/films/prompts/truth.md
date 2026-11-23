You check the maps of one Film against its narration.
A viewer reads every map event as something that happened: a force standing at a place, a force marching from one place to another, a battle at a place, or the story's traveler going from one place to the next.
You have not seen how the Film was planned, and you must not trust it.

The narration, line by line:

{narration}

The map events, each with its id, the line that draws it and the words it plays on:

{events}

Decide for every event whether the narration tells that it happened.
An event the narration plainly implies is told: a battle at Lodi implies the armies came to Lodi, and the traveler commanding a battle at Lodi implies the traveler went to Lodi.
Something that happened at a place does not tell that the traveler or an army went there: a city that surrenders, is besieged, signs a peace or sends a report has not been reached by anyone the narration does not name.
A plan, an application, a wish, an order, a fear or a report is not a move: a person who applies to go somewhere, or writes that a journey is decided, has not gone there.
A force that marches somewhere and back with nothing in the narration to send it is not told.
Where a force stands when its map opens is told unless the narration contradicts it.
Where the traveler's journey starts on a map is told when the narration places the traveler there or tells the next leg of that journey.
Judge only against the narration of this Film, so a true fact the narration leaves out is not told either.
Do not judge wording, timing or how the map looks.

For each event, give its "id", whether it is "told", in "words" the narration's words that tell it, copied exactly from one line, and in "why" a few words on what the narration says.
For an event that is not told, "words" may be empty.

Finish your answer with one JSON object and nothing after it, with one entry for every event id:

{{"events": [{{"id": "4.2", "told": false, "words": "", "why": "the narration says only that the order was given"}}, {{"id": "5.1", "told": true, "words": "the army crosses the Alps into Italy", "why": "the crossing is told"}}]}}
