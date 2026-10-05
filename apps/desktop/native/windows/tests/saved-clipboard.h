// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include "../src/clipboard.h"
#include <ole2.h>
#include <string>
#include <vector>

namespace voice {
// The test machine's clipboard as a fixture found it, every format, put back when the fixture ends,
// so a test run leaves it as it was. Tests only: the helper never reads the clipboard.
class SavedClipboard {
public:
    SavedClipboard() {
        owner.open();
        try { save(); } catch (...) { owner.close(); throw; }
        owner.close();
    }
    void restore() {
        owner.open();
        if (!EmptyClipboard()) throw std::runtime_error("clipboard restore failed");
        for (auto& item : saved) item.publish();
        owner.close();
    }
private:
    void save() {
        SIZE_T bytes = 0;
        UINT format = 0;
        while (true) {
            SetLastError(ERROR_SUCCESS);
            format = EnumClipboardFormats(format);
            if (!format) {
                if (GetLastError() != ERROR_SUCCESS) throw std::runtime_error("clipboard enumeration failed");
                break;
            }
            if (saved.size() >= 256 || format == CF_OWNERDISPLAY || (format >= CF_PRIVATEFIRST && format <= CF_GDIOBJLAST)) {
                throw std::runtime_error("clipboard cannot be preserved");
            }
            HANDLE source = GetClipboardData(format);
            if (!source) throw std::runtime_error("clipboard format unavailable (ID " + std::to_string(format) + ")");
            HANDLE copy = nullptr;
            const UINT base = format == CF_DSPBITMAP ? CF_BITMAP : format == CF_DSPMETAFILEPICT ? CF_METAFILEPICT : format;
            if (format == CF_ENHMETAFILE || format == CF_DSPENHMETAFILE) {
                copy = CopyEnhMetaFileW(static_cast<HENHMETAFILE>(source), nullptr);
            } else {
                const bool gdi = base == CF_BITMAP || base == CF_PALETTE || base == CF_METAFILEPICT;
                const auto size = gdi ? 0 : GlobalSize(source);
                if (!gdi && (!size || size > 64 * 1024 * 1024 || bytes > 64 * 1024 * 1024 - size)) {
                    throw std::runtime_error("clipboard snapshot too large");
                }
                bytes += size;
                copy = OleDuplicateData(source, static_cast<CLIPFORMAT>(base), GMEM_MOVEABLE);
            }
            if (!copy) throw std::runtime_error("clipboard copy failed");
            saved.emplace_back(format, copy);
        }
    }
    Clipboard owner;
    std::vector<ClipboardItem> saved;
};
}
