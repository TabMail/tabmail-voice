// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#pragma once
#include <windows.h>
#include <wrl/client.h>
#include <stdexcept>

namespace voice {
using Microsoft::WRL::ComPtr;
inline void require(HRESULT result) { if (FAILED(result)) throw std::runtime_error("native operation failed"); }
class COM {
public:
    COM() { require(CoInitializeEx(nullptr, COINIT_MULTITHREADED)); }
    ~COM() { CoUninitialize(); }
};
}
