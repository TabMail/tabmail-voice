# TabMail Desktop

Dictation anywhere on your Mac. Hold **Right Option (⌥)**, speak, and let go: the text is typed
into whatever you're writing in. Speech is transcribed by TabMail's servers and isn't stored.

Requires macOS 15 or later and a TabMail account.

## Build

```sh
cp LocalSigning.xcconfig.example LocalSigning.xcconfig   # set DEVELOPMENT_TEAM
./Scripts/xcodegen.sh
open TabMailDesktop.xcodeproj                            # or build with xcodebuild
```

Sign with a real team. macOS ties the Microphone and Accessibility permissions to the app's
signature, so an ad-hoc signed build loses them on every rebuild.

## First run

TabMail lives in the menu bar. It asks for:

- **Microphone**: to hear you while you hold the key.
- **Accessibility**: to notice the key from any app and to paste the text for you.

Then sign in with your TabMail email in Settings (we email you a one-time code).

## Using it

- **Hold** the dictation key, speak, **release**. A pill at the bottom of the screen shows that it's
  listening, then transcribing.
- Pressing any other key while holding cancels (so ⌥-shortcuts keep working).
- Choose Fn/Globe instead of Right Option in Settings. If you do, set System Settings › Keyboard ›
  "Press 🌐 key to" to "Do Nothing".

## License

MPL 2.0. See `LICENSE`.
