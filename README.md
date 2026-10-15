# TabMail Voice

**Dictate your intentions.**

[![Get TabMail](https://img.shields.io/badge/Get_TabMail-tabmail.ai-6D28D9)](https://tabmail.ai)
[![License: MPL 2.0](https://img.shields.io/badge/License-MPL_2.0-blue.svg)](./LICENSE)
![Platforms: macOS 15+, Windows 10 and 11, Ubuntu 26.04](https://img.shields.io/badge/platforms-macOS_15+_%7C_Windows_10%2F11_%7C_Ubuntu_26.04-lightgrey)

Dictation that knows what you're talking about. Hold **Right Option (⌥)** on a Mac,
or **Right Alt** on Windows and Linux, speak, and let go: your words are transcribed
into whatever you're writing in. With screen reading enabled, visible names, acronyms,
and terms help the transcriber recognize what you say. There is no separate filler-word or
grammar cleanup pass.

Switch to **agent mode** to dictate an intention. “Count me in” uses the
conversation on screen to write a reply. Use Answer to check your calendar and
search the web, then ask Compose to write a reply using that conversation in the
field you already have open. Review the result and send it yourself.
Speech is transcribed by TabMail's servers and isn't stored.

Runs on macOS 15 or later (Apple Silicon and Intel), Windows 10 and 11 (x64 and Arm64) and
Ubuntu 26.04 with GNOME (x64 and Arm64), with a TabMail account.
[Download it from tabmail.ai](https://tabmail.ai/download#voice-downloads). On Ubuntu, the `.deb`
adds TabMail's signed apt repository, so updates come with your system updates; without admin
(sudo) rights, use the AppImage, which updates itself. Setup for each platform:
[Set up Voice](https://tabmail.ai/docs/voice/getting-started/).

## See it in action

https://github.com/user-attachments/assets/eb30f9e0-971c-447b-8601-e2550767ee82

Can't see the video? [Watch it on YouTube](https://youtu.be/q8aHxmUA8tE) · [Try TabMail Voice](https://tabmail.ai/voice)

[Audio-described version and captions](https://tabmail.ai/demo-accessibility/#voice).

[Get TabMail](https://tabmail.ai)

## Build

The app is `apps/desktop/`, one Electron app for macOS, Windows and Linux. Its dictation path
(microphone, hotkey, paste) runs in native helpers, built from `native/<os>`, which share one Rust
core (`native/shared/rust`). It needs Node 24 and, for the helpers, Xcode on macOS; on Windows and
Linux, see [`native/windows`](apps/desktop/native/windows/README.md) and
[`native/linux`](apps/desktop/native/linux/README.md) for the toolchain and system packages:

```sh
cd apps/desktop
npx -y npm@11.19.1 install
npm start          # builds the helpers, the main process and the windows, then runs the app
                   # (on Linux: npm run start:linux)
npm test           # unit tests; also: npm run typecheck, npm run lint, ./scripts/swift-errors.sh test
npm run dist       # on macOS, a DMG and a ZIP in release/ (signed when a Developer ID is in
                   # the keychain); on Windows, an installer; on Linux, a .deb and an AppImage
```

`npm run dist` builds the app for the kind of Mac it runs on. To build the Intel app on any Mac:
`VOICE_MAC_ARCH=x64 npm run dist -- --x64` (and `arm64` likewise); for both in one,
`VOICE_MAC_ARCH=universal npm run dist -- --universal`.

An unpackaged build (what `npm start` runs) keeps a detailed log, `TabMail Voice.log` in Electron's
logs folder (on macOS, `~/Library/Logs/TabMail Voice/`): what you dictated, the text read from
your screen, every request to the TabMail backend and its reply, and what was pasted. The access token and the
audio are never in it. Packaged builds keep no log file, except while debug mode is on, which only
TabMail's own accounts can switch on.

Sign a build you keep using. macOS ties the Microphone and Accessibility permissions to the app's
signature, so an ad-hoc signed build loses them on every rebuild.

## First run

TabMail lives in the menu bar (macOS) or the system tray (Windows and Linux). A welcome window
asks for your consent to send dictations to TabMail, your name (for agent mode), whether to read
the screen, and two permissions:

- **Microphone**: to hear you while you dictate.
- **Accessibility**: to notice the key from any app and to paste the text for you.

Those two are macOS permissions. On Ubuntu, Voice instead turns on its GNOME integration, which
holds the dictation key and places the pill at your cursor: log out and back in once when asked,
then allow keyboard control when Ubuntu asks.

Then sign in with your TabMail email in Settings (we email you a one-time code).

## Using it

- **Hold** the dictation key, speak, **release**. A swirl gathers at your text cursor and turns
  into a pill whose waveform follows your voice once the microphone is listening. When you let
  go, the pill shrinks to a spinning circle while your words are transcribed, then
  the text is typed in. The language badge follows the keyboard language selected when you start
  speaking. A quick tap does nothing.
- **Double-tap** the key to dictate without holding it. Tap it again to finish, or press Esc to
  cancel.
- Pressing any other key while holding cancels (so ⌥-shortcuts keep working), except Space:
  it switches to **agent mode**, where what you say is a request, and pressing it again switches
  back. With text selected, ask to edit it; otherwise ask it to write something new, or ask a
  question. Agent mode can use your calendar, reminders, contacts, files, notes, messages, email and
  the web. Messages and new calendar, reminder, contact and note entries require confirmation;
  email opens as a draft for you to review and send. Turn each connection on or off in
  Settings › Agent mode.
- **Dictionary**: add names and terms in Settings › Dictionary so they're spelled your way. When
  you correct a word after a dictation, TabMail Voice can learn the new spelling. The dictionary
  stays on your computer.
- **Read the screen while dictating** (Settings › Dictation) sends the text in the window in
  front with your dictation, to help the transcriber recognize names and terms as they appear there. It isn't stored.
- Choose another dictation key in Settings: Fn/Globe on a Mac, Right Control on Windows, F8 or F9
  on Linux. While Fn/Globe is the hotkey, TabMail Voice sets System Settings › Keyboard ›
  "Press 🌐 key to" to "Do Nothing", and puts your choice back when you pick another key or quit.

## Privacy

Your recording, the screen text and your dictionary are sent to TabMail only to process the
dictation, and none of it is stored or used to train AI models. See the
[Privacy Policy](https://tabmail.ai/privacy/).

## Comparing speech-to-text models

`Scripts/stt-compare/` records you reading `passages.txt` (`record.py`, needs ffmpeg) and runs
every recording through several OpenRouter models (`compare.py`, needs `OPENROUTER_API_KEY`),
scoring word error rate, latency and cost. The default models are the ones whose every
OpenRouter endpoint is Zero Data Retention; the report checks that live and flags any model you
add with `--models` that isn't. Recordings and results stay local (gitignored).

`compare.py` reads `OPENROUTER_API_KEY` from the environment or from a `KEY=value` line in
`Scripts/stt-compare/.env` (gitignored; point elsewhere with `--env-file`). If your key lives in a
root-owned secrets file, leave it there and add `--sudo`: the script asks for your password, has
sudo extract only the key line, and keeps the key in memory without writing it anywhere:
```sh
python3 Scripts/stt-compare/compare.py --sudo --env-file /path/to/secrets.env
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the DCO and development workflow,
[SECURITY.md](SECURITY.md) for private vulnerability reports, and
[TRADEMARKS.md](TRADEMARKS.md) for name and logo usage.

## Acknowledgments

TabMail Voice follows patterns from [OpenWhispr](https://github.com/OpenWhispr/openwhispr) (MIT),
an open-source dictation app: one Electron app for macOS, Windows and Linux, and the approach of
its correction learner, which the dictionary's learning from the user's corrections is modeled on.
It is our own app and code, not a fork of OpenWhispr.

## License

MPL 2.0. See `LICENSE`.
