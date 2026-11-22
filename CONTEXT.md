# Pennydrop

A visual learning app that builds its own narrated, animated Lessons and high production Films on anything a person asks about.


## Learning

**Ask**:
What a person says or types to start learning, about anything. A live Ask makes Lessons with no Film.
_Avoid_: query, prompt, request

**Topic**:
One subject a person learns, holding an optional Film and the Lessons that follow it.
_Avoid_: unit, chapter

**Course**:
An ordered tree of Topics seeded from one public course syllabus, such as CS 6200.
Each Topic names the Rules it teaches, and progress through a Course is Rules held, not Lessons watched.
_Avoid_: curriculum tree, syllabus, track

**Lesson**:
A short, interactive, narrated walk through one idea that poses Challenges before it reveals answers, built live from an Ask or ahead of time for a Course.
_Avoid_: deep dive, module

**Challenge**:
What a Lesson asks of the learner before it reveals the answer: predict a number, a choice or a place, say yes or no, put things in order, match pairs, run code, or explain back in words.
_Avoid_: quiz, question, check, ask

**Rule**:
The reusable statement under a Lesson's point, with the condition it holds under and the slots a new case can change. Each Lesson teaches one.
A Rule is held once all three Forms pass on fresh Cases.
_Avoid_: seed, pattern, takeaway

**Practice**:
The three Challenges after a Lesson's last Step, one per Form, that make the learner able to use its Rule.
_Avoid_: quiz, drill, exercise

**Form**:
One of the three ways Practice tests a Rule. Say: state the Rule in your own words with a "because". Applies: say whether the Rule still works on a Near miss. Fresh: predict the result of a new Case, forward or back.
_Avoid_: mode, kind, level

**Near miss**:
A case one condition away from where a Rule holds, so the Rule fails there, such as binary search on an unsorted list.
_Avoid_: counterexample, trick question

**Case**:
One concrete instance a Practice Challenge poses, written and computed when it is served, so a review never repeats one.
_Avoid_: example, item, card

**Film**:
A high production educational film, 8 to 20 minutes, rendered offline and watched before the hands on Lessons on its Topic. It ends on open questions that seed the first Lesson's Challenges. It is its own work, not a recorded Lesson.
_Avoid_: video, deep dive, recorded lesson

**Thread**:
The one hidden idea a Film is built on. The pattern check tests it and can reject the Topic.
_Avoid_: hook, angle, pattern

**Review queue**:
The spaced list of Rules a person is practicing. Each review serves a Rule's next Form on a new Case, and a miss brings the Rule back sooner in the same Form.
_Avoid_: flashcards, quiz

**Profile**:
One learner's identity, level and Theme, which set how Lessons are pitched and drawn.
_Avoid_: account, user

**Contrast run**:
A second real run of a library algorithm, on its own object beside the main run, that serves the normal case or the break of a Lesson's story, such as linear search beside binary search.
_Avoid_: comparison, baseline

## Drawing

**Lab**:
A drawn, interactive model of one system (an array, a page table, a pendulum) that owns its layout and exposes operations in its own words.
_Avoid_: component, widget, simulator

**Set piece**:
A Lab placed inside a Film, the same Lab the Lessons on that Topic drive.
_Avoid_: cameo, embed, insert

**Step**:
One narrated beat of a Lesson: what is said, the Scene after it, and the operations its Cues fire.
_Avoid_: slide, frame, beat

**Scene**:
Everything drawn after a Step. The player reaches the next Scene by animating only what changed.
_Avoid_: state, frame, canvas

**Cue**:
The spoken word that fires an operation in a Lesson or a Film, so "swap" swaps on the word.
_Avoid_: trigger, keyframe, timestamp

**Theme**:
A swappable style that every Lab and Film draws through, chosen per Profile.
_Avoid_: skin, look, template

## Building

**Mint**:
Pennydrop's own AI that builds a new Lab when no existing Lab fits, checks that it renders, and keeps it in the data folder until it is promoted into the repo. What it builds is a minted Lab.
_Avoid_: Lab forge, forge, builder
