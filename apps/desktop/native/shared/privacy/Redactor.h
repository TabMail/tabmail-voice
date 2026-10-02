// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#ifdef _WIN32
#include <icu.h>
#else
#include <unicode/uregex.h>
#include <unicode/uchar.h>
#endif
#include <algorithm>
#include <iostream>
#include <limits>
#include <memory>
#include <span>
#include <stdexcept>
#include <string>
#include <vector>
#include "Redactors.generated.h"

namespace voice::privacy {
using Lines = std::vector<std::vector<std::u16string>>;

// Mirrors the Mac Redactor's UTF-16 boundary mapping. Each call owns its ICU
// matchers, so no captured text is retained by a cached pattern after a reply.
class Redactor {
    struct Range { size_t start, end; };
    struct Edit { size_t start, end, newStart, newEnd, keptStart, keptEnd; };
    static int32_t length(size_t count) {
        if (count > static_cast<size_t>(std::numeric_limits<int32_t>::max())) throw std::runtime_error("redaction text too long");
        return static_cast<int32_t>(count);
    }
    static std::u16string replacement(URegularExpression* regex, std::u16string_view format,
        const std::u16string& text, UErrorCode& status) {
        std::u16string result;
        for (size_t i = 0; i < format.size(); ++i) {
            if (format[i] == u'\\' && i + 1 < format.size()) { result += format[++i]; continue; }
            if (format[i] != u'$' || i + 1 == format.size() || format[i + 1] < u'0' || format[i + 1] > u'9') {
                result += format[i]; continue;
            }
            int32_t group = 0;
            while (i + 1 < format.size() && format[i + 1] >= u'0' && format[i + 1] <= u'9') {
                group = group * 10 + (format[++i] - u'0');
            }
            const int32_t start = uregex_start(regex, group, &status);
            const int32_t end = uregex_end(regex, group, &status);
            if (U_FAILURE(status)) return {};
            if (start >= 0 && end >= start) result.append(text, static_cast<size_t>(start), static_cast<size_t>(end - start));
        }
        return result;
    }
public:
    static Lines redact(const Lines& lines, std::span<const Definition> applied = definitions, int32_t stackLimit = 0) {
        std::u16string text;
        std::vector<std::vector<Range>> ranges;
        for (const auto& line : lines) {
            if (!ranges.empty()) text += u'\n';
            std::vector<Range> places;
            for (const auto& item : line) {
                const size_t start = text.size(); text += item;
                places.push_back({start, text.size()});
            }
            ranges.push_back(std::move(places));
        }
        for (const auto& definition : applied) {
            UErrorCode status = U_ZERO_ERROR;
            std::unique_ptr<URegularExpression, decltype(&uregex_close)> regex(
                uregex_open(definition.pattern.data(), length(definition.pattern.size()),
                    definition.ignoreCase ? UREGEX_CASE_INSENSITIVE : 0, nullptr, &status), &uregex_close);
            // Generated patterns failing to compile are a build defect, never an unfiltered reply.
            if (U_FAILURE(status) || !regex) throw std::runtime_error("invalid generated redactor");
            if (stackLimit > 0) uregex_setStackLimit(regex.get(), stackLimit, &status);
            uregex_setText(regex.get(), text.data(), length(text.size()), &status);
            std::u16string result;
            std::vector<Edit> edits;
            size_t copied = 0;
            while (U_SUCCESS(status) && uregex_findNext(regex.get(), &status)) {
                const int32_t from = uregex_start(regex.get(), 0, &status);
                const int32_t to = uregex_end(regex.get(), 0, &status);
                const auto replaced = replacement(regex.get(), definition.replacement, text, status);
                if (U_FAILURE(status)) break;
                const size_t start = static_cast<size_t>(from), end = static_cast<size_t>(to);
                result.append(text, copied, start - copied);
                const size_t newStart = result.size(); result += replaced;
                size_t keptStart = 0, keptEnd = 0;
                const size_t shorter = std::min(end - start, replaced.size());
                while (keptStart < shorter && text[start + keptStart] == replaced[keptStart]) ++keptStart;
                while (keptEnd < shorter - keptStart && text[end - 1 - keptEnd] == replaced[replaced.size() - 1 - keptEnd]) ++keptEnd;
                edits.push_back({start, end, newStart, result.size(), keptStart, keptEnd});
                copied = end;
            }
            if (U_FAILURE(status)) {
                std::cerr << "debug redactor unfinished: " << definition.name << '\n';
                const size_t newStart = result.size(); result += placeholder;
                edits.push_back({copied, text.size(), newStart, result.size(), 0, 0});
            } else result.append(text, copied);
            const auto moved = [&](size_t place) {
                size_t oldEnd = 0, newEnd = 0;
                for (const auto& edit : edits) {
                    if (place <= edit.start) break;
                    if (place < edit.end) {
                        if (place - edit.start <= edit.keptStart) return edit.newStart + place - edit.start;
                        return edit.newEnd - edit.keptEnd;
                    }
                    oldEnd = edit.end; newEnd = edit.newEnd;
                }
                return newEnd + (place - oldEnd);
            };
            for (auto& line : ranges) for (auto& range : line) range = {moved(range.start), moved(range.end)};
            text = std::move(result);
        }
        Lines result;
        for (const auto& line : ranges) {
            std::vector<std::u16string> items;
            for (const auto& range : line) items.push_back(text.substr(range.start, range.end - range.start));
            result.push_back(std::move(items));
        }
        return result;
    }
    static std::u16string redact(const std::u16string& text) { return redact(Lines{{text}})[0][0]; }
};
}
