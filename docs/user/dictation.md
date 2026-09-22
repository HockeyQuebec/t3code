# Dictation

You can talk to the composer instead of typing. T3 Code records what you say, transcribes it with a
Whisper CLI running on the same machine as the environment, and puts the words in the prompt box.

The audio never leaves that machine. There is no transcription service involved — T3 Code runs the
CLI you have installed, on the computer that would run the agent anyway.

## Getting set up

Install a Whisper command-line tool on the machine running your environment:

```bash
pip install whisper-ctranslate2
```

That is the faster of the two supported front-ends. OpenAI's own `whisper` works too, and so does
anything else that takes `--model`, `--output_dir` and `--output_format`. If `ffmpeg` is also
installed, T3 Code uses it to normalise clips before they reach the model, which avoids depending on
which audio formats your Whisper build was compiled with.

A microphone button appears next to the send button once a CLI is found. If nothing appears, open
**Settings › Dictation** — it says which binary it looked for and did not find.

The first time you use a model size you have not used before, it is downloaded. That download
happens on the environment's machine, and the first dictation with a new size is slower than the
rest.

## Talking

**Hold the microphone button and speak, then let go.** The recording is transcribed and the text is
added to whatever is already in the composer.

**A quick tap latches recording on** instead of ending it, so a long dictation does not need a held
finger. Tap again to stop.

**Holding the space bar** does the same thing, if you turn it on in settings. A normal press is
still a normal space — only a half-second hold starts recording, and letting go always stops it.
It only takes over the space bar when you are not typing in a text box.

You can keep editing the prompt while you talk. If you change the text that dictation has already
written, your version is kept and the next words are added after it.

## Live dictation

With live dictation on (the default), the words appear as you speak instead of all at once when you
let go. The recording is handed over in segments a few seconds long, and each one's text lands in
the composer a beat behind you.

Consecutive segments deliberately share a second of audio so a word spoken across the cut is heard
whole, and the transcripts are reconciled afterwards — so "a transcrip" followed by "a transcription
test" becomes "a transcription test", not both.

Turning live off transcribes the whole recording once, when you let go. That is a little more
accurate and a lot less immediate.

## Settings

All of these live under **Settings › Dictation**.

| Setting                    | What it does                                                                                                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dictation**              | Shows or hides the microphone.                                                                                                                                                            |
| **Whisper binary**         | Which CLI to run. A bare name is looked up on the PATH; a path is used as given, so a virtualenv's copy works.                                                                            |
| **Model**                  | The main speed dial. `tiny` and `base` come back almost immediately and mishear more; `medium` and `large-v3` are slower and sharper. `small` is a good middle.                           |
| **Fast mode**              | Greedy decoding, int8 weights, and silence skipped. Worth about 15% on `small` and 25% on `medium`, at a small cost in accuracy.                                                          |
| **Precision**              | How the weights are quantised. Only faster-whisper reads this; OpenAI's whisper ignores it.                                                                                               |
| **Language**               | The language you speak. Naming it is faster and more accurate than making the model detect it. Leave it empty to auto-detect, which is what you want just before speaking something else. |
| **Translate to English**   | Speak any language, get English.                                                                                                                                                          |
| **Live dictation**         | Put words in the composer as you speak.                                                                                                                                                   |
| **Segment length**         | Seconds of new speech per live segment. Shorter feels more immediate and asks more of the machine; longer is steadier and lags further behind.                                            |
| **Live model**             | A smaller model for live segments only, so the running transcript keeps up while the final tail still gets the main model.                                                                |
| **Space bar push-to-talk** | Hold the space bar to talk.                                                                                                                                                               |

### Real-time translation

Live dictation and translate-to-English together are real-time translation: you talk, and English
lands in the composer a few seconds behind you.

Whisper only ever translates _into_ English — it is not a language pair, so there is no target to
choose. When translating, the language setting describes what you are speaking, and leaving it empty
lets the model work that out for itself.

### Making it faster

The model size decides most of it. Beyond that, most of a short dictation is process start and model
load rather than decoding, which is why fast mode moves the number less than dropping a size does.

If live dictation is falling behind you, set a smaller **live model** rather than a smaller model.
The running transcript keeps up, and the final tail — the one that ends up in your prompt — still
gets the full model.

## Where it runs

Dictation runs on the environment the thread belongs to, not on the device you are typing from. If
you are driving a remote environment from a laptop or a phone, the audio is recorded on your device,
sent to that environment, and transcribed there — so that is the machine that needs a Whisper CLI
installed, and its settings are the ones that apply.

Recording needs a secure origin, which every normal way of reaching T3 Code provides: the desktop
app, `https://`, and `127.0.0.1` all count.
