// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include "Redactor.h"
#ifndef _WIN32
#include <unicode/ustring.h>
#endif
#include <string>

namespace voice::privacy {
// Redacts one native value (a focused field's text). A screen read's blocks and caret are redacted
// together, before rendering, in its shared reply (`screenReply`).
struct ScreenPrivacy {
    static std::u16string decode(const std::string& text) { return decodeUtf8(text); }
    static std::string encode(const std::u16string& text) { return encodeUtf16(text); }
    static std::string redact(const std::string& text) { return encode(Redactor::redact(decode(text))); }
};
}
