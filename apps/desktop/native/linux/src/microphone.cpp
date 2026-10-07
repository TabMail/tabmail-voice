// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// voice-microphone: the microphone, and nothing else, in a process of its own (ADR-DESK-032), as on
// macOS and Windows. It captures once: the process ends itself (VoiceMicrophoneRestartExitCode, after
// the replies and chunks already sent) once its session stops, its start fails, a newer start comes,
// or the running capture fails; the app starts it afresh at once and prepares it again. A dictation
// running when it ends ends as any exit of its helper ends it: what was said is sent.
//
// - `microphonePrepare` → `{}`: connects to the sound server and back, ahead of the dictation.
// - `microphoneStart {session, sampleRate}` → `{}` once the microphone runs; then events
//   `{"event": "microphoneChunk", session, samples}`, `samples` being base64 of little-endian
//   32-bit float mono samples at `sampleRate`. `microphoneStop {session}` → `{}`: the microphone off.
#include <iostream>
#include "channel.h"
#include "microphone.h"
#include "../../shared/microphone/sessions.h"

namespace {
using JSON = nlohmann::json;
int64_t session(const JSON& params) {
    if (!params.is_object() || !params.contains("session") || !params["session"].is_number_integer())
        throw std::runtime_error("invalid audio session");
    const auto value = params["session"].get<int64_t>();
    if (value <= 0) throw std::runtime_error("invalid audio session");
    return value;
}
unsigned sampleRate(const JSON& params) {
    if (!params.contains("sampleRate") || !params["sampleRate"].is_number_integer()) throw std::runtime_error("invalid audio rate");
    const auto rate = params["sampleRate"].get<int64_t>();
    if (rate < 8000 || rate > 96000) throw std::runtime_error("invalid audio rate");
    return static_cast<unsigned>(rate);
}
}
int main(int argc, char**) {
    if (argc != 1) return 1;
    voice::Output output;
    const auto end = [&output] {
        std::cerr << "debug microphone: ending, to be started afresh\n";
        output.end(VoiceMicrophoneRestartExitCode);
    };
    voice::Microphone microphone(output, [&output] {
        std::cerr << "debug microphone: capture lost; ending\n";
        output.end(VoiceMicrophoneRestartExitCode);
    });
    voice::MicrophoneSessions sessions;
    // Requests, PulseAudio and its callbacks all run on this thread's main loop.
    voice::Channel channel(output, [&](const std::string& method, const JSON& params, voice::Channel::Reply reply, int64_t) {
        if (method == "microphonePrepare") {
            if (!sessions.mayPrepare()) reply(JSON::object(), true);
            else microphone.prepare([reply](bool success) { reply(JSON::object(), success); });
        } else if (method == "microphoneStart") {
            const auto started = session(params);
            const auto rate = sampleRate(params);
            switch (sessions.start(started)) {
            case voice::MicrophoneSessions::Start::skipped:
                reply(JSON::object(), true);
                break;
            case voice::MicrophoneSessions::Start::endsProcess:
                // A start for a fresh process: the app's retry reaches the one started in its place.
                microphone.stop();
                reply(nullptr, false);
                end();
                break;
            case voice::MicrophoneSessions::Start::runs:
                microphone.start(started, rate, [&, reply, started](bool success) {
                    reply(JSON::object(), success);
                    if (success) return;
                    sessions.failed(started);
                    end();
                });
            }
        } else if (method == "microphoneStop") {
            const bool stopped = sessions.stop(session(params));
            if (stopped) microphone.stop();
            reply(JSON::object(), true);
            if (stopped) end();
        } else {
            throw std::runtime_error("unknown method");
        }
    });
    auto loop = g_main_loop_new(nullptr, false);
    g_main_loop_run(loop);
    return 0;
}
