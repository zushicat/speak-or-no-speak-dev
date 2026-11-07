# What is Speak Or No Speak? (the plain-English version)

> Part of the [Speak Or No Speak documentation](README.md) · next: [Quick start](02-quick-start.md)

This chapter needs no programming knowledge. It explains the problem this
project solves and what the project actually is. If you already know what a
voice agent is, you can skim it — but it is short, and it defines the words
used everywhere else.

## The problem: computers are bad at taking turns

When two people talk, they take turns without thinking about it. One speaks,
the other waits for the sentence to finish, maybe answers, and if someone
starts talking over the other, they both notice and stop. This "taking turns"
is something humans do automatically — but it is genuinely hard for a computer.

Imagine you talk to a voice assistant — a chatbot you speak with, a game
character, anything that listens and answers out loud. Somewhere in the
software there must be a component that answers three questions, hundreds of
times per second:

1. **Is the user speaking right now?** (so the system knows when to start paying attention)
2. **Has the user finished their thought?** (so the system knows when to start answering)
3. **Is the user talking *over* the system's answer?** (so the system knows to stop and listen)

Each of these looks trivial and is not:

- **When is a sentence finished?** A pause in the middle of a sentence
  ("let me think… okay, so") must *not* be treated as "finished". But wait too
  long after a real "okay, that's it" and the assistant feels sluggish. A fixed
  wait time is either too slow or too trigger-happy.
- **A cough is not a sentence.** Clicks, keyboard clatter, a door slam — none
  of it should count as "the user is speaking".
- **The system hears itself.** When the assistant answers out loud through
  speakers, the microphone hears the assistant's own voice. If that is not
  handled, every answer makes the system think a new user has started talking —
  the classic runaway feedback loop of half-finished voice bots.

## What Speak Or No Speak is

**Speak Or No Speak is a small piece of JavaScript that runs in the browser
and answers exactly those three questions for you.** It listens to the
microphone and hands your application three clear signals:

| Signal | Meaning |
|---|---|
| **Speech started** | The user began speaking (a cough or a click does not count). |
| **Turn ended** | The user's utterance is complete — and here is the **audio of that utterance**, ready to be transcribed. |
| **Interrupted** | The user started talking while the assistant was answering — stop the answer! |

So the name is literal: it tells your app *speak or no speak* — when the user
speaks, when they're done, and when they barged in.

It is a **library**, not a service and not an app: you add it to your own web
page. It runs **entirely in the browser** on the user's device. No server, no
account, no audio uploaded anywhere for the detection itself.

## What it is *not*

Boundaries matter as much as features. Speak Or No Speak does **not**:

- **Transcribe speech.** It hands you the audio of each utterance; turning
  sound into text is your app's job (a plug-in point is provided, see
  [Transcription](11-transcription.md)).
- **Understand or answer.** No chatbot brain, no language model, no
  text-to-speech inside. Your app produces the answers; this module only
  handles the *timing of listening*.
- **Recognize wake words or commands.** "Okay Google" style triggers are a
  different problem. This is about *when* people speak, not *what* they say.
- **Run anywhere but the browser.** Desktop Chrome/Edge and Safari are the
  supported targets; mobile browsers are out of scope for now.

## How it fits into a voice app

Your app keeps everything except the listening: the transcription (speech →
text), the answer generation (e.g. a language model), and the voice output
(text → speech). Speak Or No Speak is the "ears" in front of all of that:

```
                 ┌────────────────────── your web app ──────────────────────┐
                 │                                                          │
  user speaks ──►  [ Speak Or No Speak ] ── turn audio ──► transcription ──┤
                 │        ▲   │                                             │
                 │        │   └── speech started / interrupted ──┐           │
                 │        │                                      ▼           │
                 │        │                                 answer logic      │
                 │        │                                      │           │
                 │        └──────────── your voice output ◄──────┘           │
                 └──────────────────────────────────────────────────────────┘
```

While your app's voice output plays, you tell the module "the agent is talking
now". From that moment the module watches for the user barging in and fires
the *interrupted* signal so your app can stop talking mid-sentence — the way
two humans would.

## Why a special module at all? Doesn't a "speech detector" do this?

A plain speech detector (a VAD — *voice activity detector*) can only say
"this instant sounds like speech" or "it doesn't". That answers question 1,
badly handles question 2 (a pause inside a sentence also "isn't speech"), and
does nothing for question 3 or the echo problem. Speak Or No Speak uses a good
open speech detector under the hood ([Silero VAD](https://github.com/snakers4/silero-vad)),
and adds the layer that actually matters for conversation: **turn-taking** —
adaptive pause handling, interruption detection, and echo safety. That layer
is the product.

---

*Next: [Quick start — see it running in two minutes](02-quick-start.md) ·
Back to the [documentation index](README.md)*
