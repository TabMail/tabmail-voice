// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include <pulse/pulseaudio.h>
#include <pulse/glib-mainloop.h>
#include <glib.h>
#include <algorithm>
#include <cstdint>
#include <functional>
#include <limits>
#include <stdexcept>
#include <vector>
#include "output.h"

namespace voice {
// PipeWire's PulseAudio protocol supplies float mono at the shared recording rate. It runs in
// voice-microphone, a process of its own that captures once (ADR-DESK-032), on the process's GLib
// main loop with its requests: no AT-SPI call can hold it up. Capture exists only during a session.
class Microphone {
public:
    using Completion = std::function<void(bool)>;
    // `lost` is told when the running capture fails; the process then ends.
    Microphone(Output& output, std::function<void()> lost) : output(output), lost(std::move(lost)), loop(pa_glib_mainloop_new(nullptr)) {
        if (!loop) throw std::runtime_error("audio main loop unavailable");
    }
    ~Microphone() { stop(); pa_glib_mainloop_free(loop); }
    Microphone(const Microphone&) = delete;
    Microphone& operator=(const Microphone&) = delete;

    // Connects to the sound server and back, opening no recording stream.
    void prepare(Completion done) {
        // A running session already proves endpoint availability. Do not interrupt it.
        if (running) { done(true); return; }
        if (completion) { done(false); return; }
        begin(0, 0, std::move(done));
    }
    // `done` is told whether the microphone runs for `session`.
    void start(int64_t next, unsigned rate, Completion done) {
        stop();
        begin(next, rate, std::move(done));
    }
    // Stops the capture, if it runs, and closes the microphone.
    void stop() {
        if (timeout) { if (auto source = g_main_context_find_source_by_id(nullptr, timeout)) g_source_destroy(source); timeout = 0; }
        running = false;
        session = 0;
        if (stream) {
            pa_stream_set_state_callback(stream, nullptr, nullptr);
            pa_stream_set_read_callback(stream, nullptr, nullptr);
            pa_stream_disconnect(stream);
            pa_stream_unref(stream);
            stream = nullptr;
        }
        if (context) {
            pa_context_set_state_callback(context, nullptr, nullptr);
            pa_context_disconnect(context);
            pa_context_unref(context);
            context = nullptr;
        }
        auto canceled = std::move(completion);
        completion = {};
        if (canceled) canceled(false);
    }
private:
    Output& output;
    std::function<void()> lost;
    pa_glib_mainloop* loop = nullptr;
    pa_context* context = nullptr;
    pa_stream* stream = nullptr;
    Completion completion;
    guint timeout = 0;
    int64_t session = 0;
    unsigned sampleRate = 0;
    bool running = false;
    void fail() {
        const bool wasRunning = running;
        stop();
        if (wasRunning) lost();
    }
    void ready() {
        if (timeout) { if (auto source = g_main_context_find_source_by_id(nullptr, timeout)) g_source_destroy(source); timeout = 0; }
        auto done = std::move(completion);
        completion = {};
        if (session) running = true;
        else stop(); // prepare never opens a recording stream.
        if (done) done(true);
    }
    void begin(int64_t next, unsigned rate, Completion done) {
        completion = std::move(done);
        session = next;
        sampleRate = rate;
        auto deadline = g_timeout_source_new(3000);
        g_source_set_callback(deadline, [](gpointer data) -> gboolean {
            auto self = static_cast<Microphone*>(data);
            self->timeout = 0;
            self->fail();
            return G_SOURCE_REMOVE;
        }, this, nullptr);
        timeout = g_source_attach(deadline, nullptr);
        g_source_unref(deadline);
        context = pa_context_new(pa_glib_mainloop_get_api(loop), "TabMail Voice");
        if (!context) { fail(); return; }
        pa_context_set_state_callback(context, [](pa_context* value, void* data) {
            auto self = static_cast<Microphone*>(data);
            const auto state = pa_context_get_state(value);
            if (state == PA_CONTEXT_READY) self->connected();
            else if (!PA_CONTEXT_IS_GOOD(state)) self->fail();
        }, this);
        if (pa_context_connect(context, nullptr, PA_CONTEXT_NOAUTOSPAWN, nullptr) < 0) fail();
    }
    void connected() {
        if (!session) { ready(); return; }
        const pa_sample_spec format{PA_SAMPLE_FLOAT32LE, sampleRate, 1};
        stream = pa_stream_new(context, "Dictation microphone", &format, nullptr);
        if (!stream) { fail(); return; }
        pa_stream_set_state_callback(stream, [](pa_stream* value, void* data) {
            auto self = static_cast<Microphone*>(data);
            const auto state = pa_stream_get_state(value);
            if (state == PA_STREAM_READY) self->ready();
            else if (!PA_STREAM_IS_GOOD(state)) self->fail();
        }, this);
        pa_stream_set_read_callback(stream, [](pa_stream*, size_t, void* data) {
            static_cast<Microphone*>(data)->read();
        }, this);
        pa_buffer_attr timing{};
        timing.maxlength = std::numeric_limits<uint32_t>::max();
        timing.tlength = timing.prebuf = timing.minreq = std::numeric_limits<uint32_t>::max();
        timing.fragsize = sampleRate * sizeof(float) / 50;
        if (pa_stream_connect_record(stream, nullptr, &timing, PA_STREAM_ADJUST_LATENCY) < 0) fail();
    }
    void read() {
        const void* data = nullptr;
        size_t length = 0;
        if (pa_stream_peek(stream, &data, &length) < 0) { fail(); return; }
        if (!length) return;
        if (length > 64 * 1024 || length % sizeof(float)) { fail(); return; }
        std::vector<guchar> bytes(length, 0);
        if (data) std::copy_n(static_cast<const guchar*>(data), length, bytes.begin());
        // Release the driver buffer before encoding or queueing audio.
        if (pa_stream_drop(stream) < 0) { fail(); return; }
        gchar* encoded = g_base64_encode(bytes.data(), bytes.size());
        output.send({{"event", "microphoneChunk"}, {"session", session}, {"samples", encoded}});
        g_free(encoded);
    }
};
}
