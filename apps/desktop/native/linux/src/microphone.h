// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include <pulse/pulseaudio.h>
#include <pulse/glib-mainloop.h>
#include <glib.h>
#include <functional>
#include <future>
#include <thread>
#include <memory>
#include <atomic>
#include <limits>
#include <vector>
#include "output.h"

namespace voice {
// PipeWire's PulseAudio protocol supplies float mono at the shared recording rate.
// GLib owns control and driver callbacks; capture exists only during a native session.
class AudioSession {
public:
    using Completion = std::function<void(bool)>;
    explicit AudioSession(Output& output, GMainContext* context) : output(output), loop(pa_glib_mainloop_new(context)), audioContext(context) {
        if (!loop) throw std::runtime_error("audio main loop unavailable");
    }
    ~AudioSession() { stopCurrent(); pa_glib_mainloop_free(loop); }
    AudioSession(const AudioSession&) = delete;
    AudioSession& operator=(const AudioSession&) = delete;

    void prepare(Completion done) {
        // A running session already proves endpoint availability. Do not interrupt it.
        if (running) { done(true); return; }
        if (completion) { done(false); return; }
        begin(0, 0, std::move(done));
    }
    void start(int next, unsigned rate, Completion done) {
        if (next <= newestSession || next <= 0 || rate < 8000 || rate > 96000) { done(false); return; }
        stopCurrent();
        newestSession = next;
        begin(next, rate, std::move(done));
    }
    void stop(int stoppedSession) { if (stoppedSession == session) stopCurrent(); }
    void stopCurrent() {
        if (timeout) { if (auto source = g_main_context_find_source_by_id(audioContext, timeout)) g_source_destroy(source); timeout = 0; }
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
    pa_glib_mainloop* loop = nullptr;
    pa_context* context = nullptr;
    pa_stream* stream = nullptr;
    Completion completion;
    guint timeout = 0;
    int session = 0;
    int newestSession = 0;
    unsigned sampleRate = 0;
    bool running = false;
    GMainContext* audioContext = nullptr;
    void fail() {
        if (running) output.send({{"event", "microphoneLost"}, {"session", session}});
        stopCurrent();
    }
    void ready() {
        if (timeout) { if (auto source = g_main_context_find_source_by_id(audioContext, timeout)) g_source_destroy(source); timeout = 0; }
        auto done = std::move(completion);
        completion = {};
        if (session) running = true;
        else stopCurrent(); // prepare never opens a recording stream.
        if (done) done(true);
    }
    void begin(int next, unsigned rate, Completion done) {
        completion = std::move(done);
        session = next;
        sampleRate = rate;
        auto deadline = g_timeout_source_new(3000);
        g_source_set_callback(deadline, [](gpointer data) -> gboolean {
            auto self = static_cast<AudioSession*>(data);
            self->timeout = 0;
            self->fail();
            return G_SOURCE_REMOVE;
        }, this, nullptr);
        timeout = g_source_attach(deadline, audioContext);
        g_source_unref(deadline);
        context = pa_context_new(pa_glib_mainloop_get_api(loop), "TabMail Voice");
        if (!context) { fail(); return; }
        pa_context_set_state_callback(context, [](pa_context* value, void* data) {
            auto self = static_cast<AudioSession*>(data);
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
            auto self = static_cast<AudioSession*>(data);
            const auto state = pa_stream_get_state(value);
            if (state == PA_STREAM_READY) self->ready();
            else if (!PA_STREAM_IS_GOOD(state)) self->fail();
        }, this);
        pa_stream_set_read_callback(stream, [](pa_stream*, size_t, void* data) {
            static_cast<AudioSession*>(data)->read();
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
// A separate GLib context keeps provider timeouts in AT-SPI from starving capture.
// Each invocation and every PulseAudio callback runs on this worker; no driver object
// crosses thread boundaries. The shared app still owns waveform timing and filtering.
class Microphone {
public:
    using Completion = AudioSession::Completion;
    explicit Microphone(Output& output) {
        auto ready = std::make_shared<std::promise<void>>();
        auto started = ready->get_future();
        worker = std::thread([this, &output, ready] {
            context = g_main_context_new();
            g_main_context_push_thread_default(context);
            loop = g_main_loop_new(context, false);
            try { capture = std::make_unique<AudioSession>(output, context); ready->set_value(); }
            catch (...) { ready->set_exception(std::current_exception()); }
            if (capture) g_main_loop_run(loop);
            capture.reset();
            g_main_loop_unref(loop);
            g_main_context_pop_thread_default(context);
            g_main_context_unref(context);
        });
        try { started.get(); }
        catch (...) { worker.join(); throw; }
    }
    ~Microphone() { invoke([this] { g_main_loop_quit(loop); }); worker.join(); }
    void prepare(Completion done) { invoke([this, done = std::move(done)]() mutable { capture->prepare(std::move(done)); }); }
    void start(int session, unsigned rate, Completion done) { invoke([this, session, rate, done = std::move(done)]() mutable { capture->start(session, rate, std::move(done)); }); }
    void stop(int session, Completion done = {}) {
        invoke([this, session, done = std::move(done)] { capture->stop(session); if (done) done(true); });
    }
private:
    GMainContext* context = nullptr;
    GMainLoop* loop = nullptr;
    std::unique_ptr<AudioSession> capture;
    std::thread worker;
    std::atomic<unsigned> queued{0};
    void invoke(std::function<void()> work) {
        if (queued.fetch_add(1) >= 32) std::_Exit(1);
        auto bounded = [this, work = std::move(work)] { queued.fetch_sub(1); work(); };
        auto value = new std::function<void()>(std::move(bounded));
        // Always attach a source. g_main_context_invoke can execute on the caller,
        // which would violate the driver's single-thread ownership during startup.
        auto source = g_idle_source_new();
        g_source_set_priority(source, G_PRIORITY_DEFAULT);
        g_source_set_callback(source, [](gpointer data) -> gboolean {
            (*static_cast<std::function<void()>*>(data))();
            return G_SOURCE_REMOVE;
        }, value, [](gpointer data) { delete static_cast<std::function<void()>*>(data); });
        g_source_attach(source, context);
        g_source_unref(source);
    }
};
}
