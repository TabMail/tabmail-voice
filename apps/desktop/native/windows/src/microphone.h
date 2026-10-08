// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#pragma once
#include <windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <wincrypt.h>
#include <cstring>
#include <stdexcept>
#include <cstdint>
#include <functional>
#include <future>
#include <thread>
#include <vector>
#include "com.h"
#include "output.h"

namespace voice {
class Handle {
public:
    HANDLE value;
    explicit Handle(bool manual = false) : value(CreateEventW(nullptr, manual, FALSE, nullptr)) {
        if (!value) throw std::runtime_error("event unavailable");
    }
    ~Handle() { CloseHandle(value); }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
};
inline std::string base64(const std::vector<float>& samples) {
    const auto bytes = static_cast<DWORD>(samples.size() * sizeof(float));
    DWORD length = 0;
    const DWORD flags = CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF;
    if (!CryptBinaryToStringA(reinterpret_cast<const BYTE*>(samples.data()), bytes, flags, nullptr, &length)) {
        throw std::runtime_error("audio encoding failed");
    }
    std::string result(length, '\0');
    if (!CryptBinaryToStringA(reinterpret_cast<const BYTE*>(samples.data()), bytes, flags, result.data(), &length)) {
        throw std::runtime_error("audio encoding failed");
    }
    result.resize(length);
    return result;
}

// Event-driven shared streams let the audio engine choose both timing values.
// Keep the actual call shared with the native contract test's recording client.
template <typename AudioClient>
HRESULT initializeCapture(AudioClient& client, unsigned rate) {
    WAVEFORMATEX format{};
    format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
    format.nChannels = 1;
    format.nSamplesPerSec = rate;
    format.wBitsPerSample = 32;
    format.nBlockAlign = 4;
    format.nAvgBytesPerSec = rate * 4;
    return client.Initialize(AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
        0, 0, &format, nullptr);
}

// WASAPI's shared engine converts to the app's float mono recording rate. It runs in
// voice-microphone.exe, a process of its own that captures once (ADR-DESK-032), so no UI Automation
// call can hold it up or end it. Each start opens the default endpoint afresh; prepare only checks
// that there is one and opens nothing.
class Microphone {
public:
    // `lost` is told when the running capture fails; the process then ends.
    Microphone(const Output& output, std::function<void()> lost) : output(output), lost(std::move(lost)) {}
    void prepare() {
        COM com;
        ComPtr<IMMDeviceEnumerator> enumerator;
        require(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator)));
        ComPtr<IMMDevice> device;
        require(enumerator->GetDefaultAudioEndpoint(eCapture, eCommunications, &device));
    }
    // Returns once the microphone runs for `session`; throws when it can't start.
    void start(int64_t session, unsigned rate) {
        auto started = std::make_shared<std::promise<void>>();
        auto ready = started->get_future();
        worker = std::thread([this, session, rate, started] {
            bool running = false;
            try {
                COM com;
                ComPtr<IMMDeviceEnumerator> enumerator;
                require(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator)));
                ComPtr<IMMDevice> device;
                require(enumerator->GetDefaultAudioEndpoint(eCapture, eCommunications, &device));
                ComPtr<IAudioClient> client;
                require(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(client.GetAddressOf())));
                require(initializeCapture(*client.Get(), rate));
                Handle audioEvent;
                require(client->SetEventHandle(audioEvent.value));
                ComPtr<IAudioCaptureClient> capture;
                require(client->GetService(IID_PPV_ARGS(&capture)));
                require(client->Start());
                running = true;
                started->set_value();
                HANDLE events[] = {stopEvent.value, audioEvent.value};
                while (true) {
                    const DWORD status = WaitForMultipleObjects(2, events, FALSE, 250);
                    if (status == WAIT_OBJECT_0) break;
                    if (status == WAIT_FAILED) throw std::runtime_error("capture wait failed");
                    UINT32 available = 0;
                    require(capture->GetNextPacketSize(&available));
                    while (available != 0) {
                        BYTE* data = nullptr;
                        UINT32 frames = 0;
                        DWORD flags = 0;
                        require(capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr));
                        std::vector<float> samples(frames, 0.0f);
                        if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT)) {
                            memcpy(samples.data(), data, frames * sizeof(float));
                        }
                        // Release the driver buffer before encoding or sending anything.
                        require(capture->ReleaseBuffer(frames));
                        if (WaitForSingleObject(stopEvent.value, 0) == WAIT_OBJECT_0) break;
                        output.send({{"event", "microphoneChunk"}, {"session", session}, {"samples", base64(samples)}});
                        require(capture->GetNextPacketSize(&available));
                    }
                }
                require(client->Stop());
            } catch (...) {
                // An endpoint that goes away mid-capture fails the capture call.
                if (running) lost();
                else started->set_exception(std::current_exception());
            }
            // All COM references leave scope here, closing the microphone on success or failure.
        });
        try { ready.get(); }
        catch (...) { stop(); throw; }
    }
    // Stops the capture, if it runs, and closes the microphone.
    void stop() {
        SetEvent(stopEvent.value);
        if (worker.joinable()) worker.join();
    }
private:
    const Output& output;
    std::function<void()> lost;
    Handle stopEvent{true};
    std::thread worker;
};
}
