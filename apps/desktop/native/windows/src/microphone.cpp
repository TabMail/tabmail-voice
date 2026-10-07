// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// voice-microphone.exe: the microphone, and nothing else, in a process of its own (ADR-DESK-032),
// as on macOS and Linux. It captures once: the process ends itself (VoiceMicrophoneRestartExitCode,
// after the replies and chunks already sent) once its session stops, its start fails, a newer start
// comes, or the running capture fails; the app starts it afresh at once and prepares it again. A
// dictation running when it ends ends as any exit of its helper ends it: what was said is sent.
//
// - `microphonePrepare` → `{}`: checks there is a default capture endpoint, ahead of the dictation.
// - `microphoneStart {session, sampleRate}` → `{}` once the microphone runs; then events
//   `{"event": "microphoneChunk", session, samples}`, `samples` being base64 of little-endian
//   32-bit float mono samples at `sampleRate`. `microphoneStop {session}` → `{}`: the microphone off.
#include <windows.h>
#include <nlohmann/json.hpp>
#include <iostream>
#include <string>
#include "microphone.h"
#include "../../shared/microphone/sessions.h"

using JSON = nlohmann::json;
int main(int argc, char**) {
    if (argc != 1) return 1;
    voice::Output output;
    const auto end = [&output] { output.end(VoiceMicrophoneRestartExitCode); };
    voice::Microphone microphone(output, [end] {
        std::cerr << "debug microphone: capture lost; ending\n";
        end();
    });
    voice::MicrophoneSessions sessions;
    std::string line;
    char byte;
    while (std::cin.get(byte)) {
        if (byte != '\n') {
            if (line.size() >= 1024 * 1024) ExitProcess(1);
            line.push_back(byte);
            continue;
        }
        auto input = JSON::parse(line, nullptr, false);
        line.clear();
        if (!input.is_object() || !input.contains("id") || !input["id"].is_number_integer() ||
            !input.contains("method") || !input["method"].is_string()) continue;
        const auto id = input["id"];
        const auto method = input["method"].get<std::string>();
        const auto params = input.value("params", JSON::object());
        bool ends = false;
        try {
            if (method == "microphonePrepare") {
                if (sessions.mayPrepare()) microphone.prepare();
            } else if (method == "microphoneStart") {
                const auto request = voice::microphoneRequest(method, params);
                const auto started = request.session;
                switch (sessions.start(started)) {
                case voice::MicrophoneSessions::Start::skipped:
                    break;
                case voice::MicrophoneSessions::Start::endsProcess:
                    // A start for a fresh process: the app's retry reaches the one started in its place.
                    ends = true;
                    microphone.stop();
                    throw std::runtime_error("microphone already used");
                case voice::MicrophoneSessions::Start::runs:
                    try { microphone.start(started, request.sampleRate); }
                    catch (...) {
                        sessions.failed(started);
                        ends = true;
                        throw;
                    }
                }
            } else if (method == "microphoneStop") {
                if (sessions.stop(voice::microphoneRequest(method, params).session)) {
                    microphone.stop();
                    ends = true;
                }
            } else {
                throw std::runtime_error("unsupported native operation");
            }
            output.send({{"id", id}, {"result", JSON::object()}});
        } catch (...) {
            // Never echo parameters or native exception details into logs.
            output.send({{"id", id}, {"error", {{"message", "Windows microphone request failed"}}}});
        }
        if (ends) {
            std::cerr << "debug microphone: ending, to be started afresh\n";
            end();
        }
    }
    microphone.stop();
    // Output owns a process-lifetime writer thread. EOF closes the microphone and ends the process.
    ExitProcess(0);
}
