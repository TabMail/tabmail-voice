// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#include "microphone.h"
#include <stdexcept>
#include <iostream>
struct RecordingClient {
    bool called = false;
    unsigned expectedRate;
    HRESULT Initialize(AUDCLNT_SHAREMODE mode, DWORD flags, REFERENCE_TIME buffer,
                       REFERENCE_TIME periodicity, const WAVEFORMATEX* format, LPCGUID session) {
        called = true;
        if (mode != AUDCLNT_SHAREMODE_SHARED || !(flags & AUDCLNT_STREAMFLAGS_EVENTCALLBACK)
            || buffer != 0 || periodicity != 0 || session != nullptr
            || !(flags & AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM)
            || format->wFormatTag != WAVE_FORMAT_IEEE_FLOAT || format->nChannels != 1
            || format->nSamplesPerSec != expectedRate || format->wBitsPerSample != 32
            || format->nBlockAlign != 4 || format->nAvgBytesPerSec != expectedRate * 4)
            throw std::runtime_error("shared event-driven capture contract violated");
        return E_FAIL;
    }
};
int main() {
    try {
        for (unsigned rate : {16000u, 48000u}) {
            RecordingClient client{false, rate};
            if (voice::initializeCapture(client, rate) != E_FAIL || !client.called)
                throw std::runtime_error("initialization must propagate the device result");
        }
        std::cout << "event-driven capture timing, format and failure propagation passed\n";
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
