// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include "../rust/VoiceCore.h"
#include <string_view>
#include <array>
namespace voice {
// Scoped ownership only. Selection, normalization and acquisition stop decisions
// come from Rust; this adapter does not count or truncate text.
class SemanticText {
public:
    enum class Kind : uint32_t { row = 1, heading = 2, link = 3 };
    enum class Decision : uint32_t { root = 1, descendants = 2, complete = 3, budgetFull = 4 };
    enum class Event : uint32_t { root = 1, descendant = 2, complete = 3, interrupted = 4 };
    explicit SemanticText(Kind kind) {
        if (voice_core_abi_version() != 1 || voice_core_semantic_new(static_cast<uint32_t>(kind), &state, &next) != 0)
            throw std::runtime_error("shared semantic core refused");
    }
    ~SemanticText() { voice_core_semantic_free(state); }
    SemanticText(const SemanticText&) = delete;
    SemanticText& operator=(const SemanticText&) = delete;
    Decision decision() const { return static_cast<Decision>(next); }
    void offer(Event event, std::string_view text = {}) {
        if (voice_core_semantic_offer(state, static_cast<uint32_t>(event), reinterpret_cast<const uint8_t*>(text.data()), text.size(), &next) != 0)
            throw std::runtime_error("shared semantic core refused");
    }
    void offerProjected(Event event, const std::array<std::string, 3>& parts) {
        const auto input = nlohmann::json(parts).dump();
        if (voice_core_semantic_offer_projected(state, static_cast<uint32_t>(event),
            reinterpret_cast<const uint8_t*>(input.data()), input.size(), &next) != 0)
            throw std::runtime_error("shared semantic core refused");
    }
    nlohmann::json projectedSource() const {
        struct Reply { VoiceCoreBuffer value{}; ~Reply() { voice_core_buffer_free(value); } } reply;
        if (voice_core_semantic_finish_projected(state, &reply.value) != 0 || !reply.value.data)
            throw std::runtime_error("shared semantic core refused");
        return nlohmann::json::parse(reply.value.data, reply.value.data + reply.value.length);
    }
    // Private source text: final shared redaction/presentation must run before use.
    std::string source() const {
        struct Reply { VoiceCoreBuffer value{}; ~Reply() { voice_core_buffer_free(value); } } reply;
        if (voice_core_semantic_finish(state, &reply.value) != 0 || !reply.value.data)
            throw std::runtime_error("shared semantic core refused");
        return std::string(reinterpret_cast<const char*>(reply.value.data), reply.value.length);
    }
private:
    VoiceSemanticText* state = nullptr;
    uint32_t next = 0;
};
}
