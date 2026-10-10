// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#pragma once
#include <windows.h>
#include <wrl/client.h>
#include <cstdio>
#include <stdexcept>
#include <string>

namespace voice {
using Microsoft::WRL::ComPtr;
inline void require(HRESULT result) {
    if (!FAILED(result)) return;
    // The HRESULT names the failure (a UIA timeout, an element gone) for the debug log; it is a code, never content.
    char code[11];
    snprintf(code, sizeof(code), "0x%08lX", static_cast<unsigned long>(result));
    throw std::runtime_error(std::string("native operation failed ") + code);
}
class COM {
public:
    COM() { require(CoInitializeEx(nullptr, COINIT_MULTITHREADED)); }
    ~COM() { CoUninitialize(); }
};
}
