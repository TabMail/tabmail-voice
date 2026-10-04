// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include <nlohmann/json.hpp>
#include <stdexcept>
#include "include/voice_core.h"
namespace voice::core {
using Operation = uint32_t (*)(const uint8_t*, size_t, VoiceCoreBuffer*);
inline nlohmann::json request(const nlohmann::json& request, Operation operation) {
    if (voice_core_abi_version() != 1) throw std::runtime_error("shared core ABI mismatch");
    const auto input = request.dump();
    struct Reply { VoiceCoreBuffer buffer{}; ~Reply() { voice_core_buffer_free(buffer); } } reply;
    const auto status = operation(reinterpret_cast<const uint8_t*>(input.data()), input.size(), &reply.buffer);
    if (status != 0 || !reply.buffer.data) throw std::runtime_error("shared core refused");
    try { return nlohmann::json::parse(reply.buffer.data, reply.buffer.data + reply.buffer.length); }
    catch (...) { throw std::runtime_error("invalid shared core reply"); }
}
}
