// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#pragma once
#include <windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <wincrypt.h>
#include <wrl/client.h>
#include <cstring>
#include <stdexcept>
#include <future>
#include <thread>
#include <vector>
#include "output.h"

namespace voice {
using Microsoft::WRL::ComPtr;
inline void require(HRESULT result) { if (FAILED(result)) throw std::runtime_error("native operation failed"); }
class COM {
public:
    COM() { require(CoInitializeEx(nullptr, COINIT_MULTITHREADED)); }
    ~COM() { CoUninitialize(); }
};
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

// WASAPI's shared engine converts to the app's float mono recording rate. Each start owns
// a fresh audio client; prepare only checks endpoint availability, never starts capture.
// Control stays on the stdin thread, separate from potentially blocking UI Automation calls.
class Microphone {
public:
    explicit Microphone(const Output& output) : output(output) {}
    void prepare() {
        COM com;
        ComPtr<IMMDeviceEnumerator> enumerator;
        require(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator)));
        ComPtr<IMMDevice> device;
        require(enumerator->GetDefaultAudioEndpoint(eCapture, eCommunications, &device));
    }
    void start(int nextSession, unsigned rate) {
        if (nextSession <= newestSession) throw std::runtime_error("stale microphone session");
        stopCurrent();
        newestSession = nextSession;
        session = nextSession;
        ResetEvent(stopEvent.value);
        auto started = std::make_shared<std::promise<void>>();
        auto ready = started->get_future();
        worker = std::thread([this, nextSession, rate, started] {
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
                        output.send({{"event", "microphoneChunk"}, {"session", nextSession}, {"samples", base64(samples)}});
                        require(capture->GetNextPacketSize(&available));
                    }
                }
                require(client->Stop());
            } catch (...) {
                if (running) output.send({{"event", "microphoneLost"}, {"session", nextSession}});
                else started->set_exception(std::current_exception());
            }
            // All COM references leave scope here, closing the microphone on success or failure.
        });
        try { ready.get(); }
        catch (...) { stopCurrent(); throw; }
    }
    void stop(int stoppedSession) {
        if (stoppedSession == session) stopCurrent();
    }
    void stopCurrent() {
        SetEvent(stopEvent.value);
        if (worker.joinable()) worker.join();
        session = 0;
    }
private:
    const Output& output;
    Handle stopEvent{true};
    std::thread worker;
    int session = 0;
    int newestSession = 0;
};
}
