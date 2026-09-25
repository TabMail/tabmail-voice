# TabMail Desktop

Dictation anywhere on your Mac. Hold **Right Option (⌥)**, speak, and let go: the text is typed
into whatever you're writing in. Speech is transcribed by TabMail's servers and isn't stored.

Requires macOS 15 or later and a TabMail account.

## Build

1. Create your secrets file from the template and set your Apple Developer Team ID:
   ```sh
   cp Secrets.xcconfig.example Secrets.xcconfig
   ```
   `Secrets.xcconfig` is gitignored. The comments in the template explain each value.
2. Generate the Xcode project (requires [XcodeGen](https://github.com/yonaskolb/XcodeGen)):
   ```sh
   ./Scripts/xcodegen.sh
   ```
   Always use this script rather than a bare `xcodegen generate`: it reads your
   `DEVELOPMENT_TEAM` from `Secrets.xcconfig` and passes it to XcodeGen.
3. Open `TabMailDesktop.xcodeproj` and run the `TabMailDesktop` scheme, or run the tests:
   ```sh
   xcodebuild -project TabMailDesktop.xcodeproj -scheme TabMailDesktop -derivedDataPath DerivedData test
   ```

Sign with a real team. macOS ties the Microphone and Accessibility permissions to the app's
signature, so an ad-hoc signed build loses them on every rebuild.

## First run

TabMail lives in the menu bar. It asks for:

- **Microphone**: to hear you while you hold the key.
- **Accessibility**: to notice the key from any app and to paste the text for you.

Then sign in with your TabMail email in Settings (we email you a one-time code).

## Using it

- **Hold** the dictation key, speak, **release**. A swirl gathers at your text cursor and turns
  into a waveform pill once the microphone is listening; the text is typed in when you let go.
  A quick tap does nothing.
- Pressing any other key while holding cancels (so ⌥-shortcuts keep working).
- Choose Fn/Globe instead of Right Option in Settings. If you do, set System Settings › Keyboard ›
  "Press 🌐 key to" to "Do Nothing".

## Comparing speech-to-text models

`Scripts/stt-compare/` records you reading `passages.txt` (`record.py`, needs ffmpeg) and runs
every recording through several OpenRouter models (`compare.py`, needs `OPENROUTER_API_KEY`),
scoring word error rate, latency and cost. Recordings and results stay local (gitignored).

## License

MPL 2.0. See `LICENSE`.
