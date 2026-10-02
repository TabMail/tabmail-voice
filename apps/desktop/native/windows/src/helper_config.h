// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#pragma once
#include <cstdint>
namespace voice::HelperConfig {
inline constexpr uint32_t accessibilityRequestTimeoutMs = 1000;
inline constexpr uint32_t accessibilityRetryIntervalMs = 1000;
inline constexpr unsigned accessibilityMaxAttempts = 5;
}
