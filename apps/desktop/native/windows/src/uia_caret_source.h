// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include <windows.h>
#include <ole2.h>
#include <UIAutomation.h>
#include <iostream>
#include "helper_config.h"
#include "microphone.h"
#include "text.h"
#include "../../shared/context/CaretSource.h"
#include "../../shared/context/walk.h"
#include "../../shared/context/screen_context.h"

namespace voice {
// UIA endpoints are opaque; Character may fall back to a larger supported unit.
// Validate actual returned text and endpoint relationships, never a moved count.
class UiaCaretSource {
public:
    static CaretSource read(IUIAutomationTextPattern* pattern, ULONGLONG started) {
        UiaCaretSource reader(started);
        auto selected = reader.selection(pattern);
        ComPtr<IUIAutomationTextRange> document;
        reader.check(); require(pattern->get_DocumentRange(&document)); reader.check();
        if (!selected || !document || !reader.containSelection(selected.Get(), document.Get())) return CaretSource::unavailable();
        const auto limits = core::request({{"limits", true}}, voice_core_context_json);
        const auto selectionLimit = limits.at("selectionSourceBytes").get<size_t>();
        const auto sourceLimit = limits.at("sourceWindowBytes").get<size_t>();
        const auto selectionText = reader.text(selected.Get(), selectionLimit);
        if (!selectionText) return CaretSource::unavailable();
        const auto before = reader.side(selected.Get(), document.Get(), true, sourceLimit);
        const auto after = reader.side(selected.Get(), document.Get(), false, sourceLimit);
        const auto caretStarts = reader.starts(selected.Get());
        auto finalSelection = reader.selection(pattern);
        ComPtr<IUIAutomationTextRange> finalDocument;
        reader.check(); require(pattern->get_DocumentRange(&finalDocument)); reader.check();
        if (!finalSelection || !finalDocument || !reader.containSelection(finalSelection.Get(), finalDocument.Get())) return CaretSource::unavailable();
        BOOL sameSelection = FALSE, sameDocument = FALSE;
        require(selected->Compare(finalSelection.Get(), &sameSelection));
        require(document->Compare(finalDocument.Get(), &sameDocument));
        reader.check();
        if (!sameSelection || !sameDocument || reader.text(finalSelection.Get(), selectionLimit) != selectionText) return CaretSource::unavailable();
        return CaretSource::window({before.first, *selectionText, after.first}, before.second, after.second, caretStarts);
    }
    // Caller proves privacy, visible provider identity and focus. Every GetText
    // stays inside an approved visible range. Do not constrain terminal ranges
    // to DocumentRange: Windows Terminal ends that range beneath its cursor or
    // last text, while GetVisibleRanges also includes the remaining blank rows.
    static nlohmann::json viewportSurface(IUIAutomationTextPattern* pattern, size_t id,
        ContextFrame frame, bool focused, size_t byteBudget, ULONGLONG started) {
        UiaCaretSource reader(started, HelperConfig::terminalReadBudgetMs);
        const auto start = TextPatternRangeEndpoint_Start, end = TextPatternRangeEndpoint_End;
        const auto limits = core::request({{"limits", true}}, voice_core_viewport_json);
        const size_t limit = std::min(byteBudget, limits.at("bytes").get<size_t>());
        const int rangeLimit = limits.at("runs").get<int>();
        const auto selectedRanges = [&] {
            ComPtr<IUIAutomationTextRangeArray> array;
            reader.check(); require(pattern->GetSelection(&array)); reader.check();
            if (!array) throw std::runtime_error("terminal selection unavailable");
            int count = 0; require(array->get_Length(&count));
            if (count < 0 || count > rangeLimit) throw std::runtime_error("terminal selection count");
            std::vector<ComPtr<IUIAutomationTextRange>> result;
            for (int i = 0; i < count; ++i) {
                ComPtr<IUIAutomationTextRange> item; require(array->GetElement(i, &item));
                if (!item || reader.compare(item.Get(), start, item.Get(), end) > 0 ||
                    (!result.empty() && reader.compare(result.back().Get(), end, item.Get(), start) > 0))
                    throw std::runtime_error("terminal selection range");
                result.push_back(item);
            }
            return result;
        };
        const auto selected = selectedRanges();
        ComPtr<IUIAutomationTextPattern2> advanced;
        pattern->QueryInterface(IID_PPV_ARGS(&advanced));
        const auto caretRange = [&] {
            ComPtr<IUIAutomationTextRange> result;
            if (!focused) return result;
            if (advanced) {
                BOOL active = FALSE; reader.check();
                const HRESULT status = advanced->GetCaretRange(&active, &result); reader.check();
                if (FAILED(status) || !active) result.Reset();
            } else if (selected.size() == 1 && reader.compare(selected[0].Get(), start, selected[0].Get(), end) == 0) {
                require(selected[0]->Clone(&result));
            }
            if (result && reader.compare(result.Get(), start, result.Get(), end) != 0) result.Reset();
            return result;
        };
        auto caret = caretRange();
        auto ranges = reader.visibleRanges(pattern, nullptr, rangeLimit);
        nlohmann::json runs = nlohmann::json::array(), selections = nlohmann::json::array();
        const bool hasVisibleText = std::any_of(ranges.begin(), ranges.end(), [&](const auto& range) {
            return reader.compare(range.Get(), start, range.Get(), end) < 0;
        });
        nlohmann::json anchor = {{"status", caret && hasVisibleText ? "outsideViewport" : "unavailable"}};
        std::vector<std::string> captured;
        std::vector<ComPtr<IUIAutomationTextRange>> covered;
        for (const auto& selection : selected) {
            ComPtr<IUIAutomationTextRange> item; require(selection->Clone(&item));
            reader.move(item.Get(), end, item.Get(), start); covered.push_back(item);
        }
        bool completeSelection = true;
        size_t remaining = limit;
        const auto units = [](const std::string& text) -> size_t {
            if (text.empty()) return 0;
            const int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0);
            if (count <= 0) throw std::runtime_error("terminal text encoding");
            return static_cast<size_t>(count);
        };
        for (size_t i = 0; i < ranges.size(); ++i) {
            auto* visible = ranges[i].Get();
            if (i && reader.compare(ranges[i-1].Get(), end, visible, start) > 0) throw std::runtime_error("overlapping terminal ranges");
            const auto value = reader.text(visible, remaining);
            if (!value) throw std::runtime_error("terminal viewport budget");
            remaining -= value->size(); captured.push_back(*value);
            // Split only by exact native endpoints, never by Character moved
            // counts. Recomposition detects trimmed/normalized provider text, or output that
            // arrived since the run was read: the offset is then unknown, and the run is kept.
            const auto offset = [&](IUIAutomationTextRange* point, TextPatternRangeEndpoint endpoint) -> std::optional<size_t> {
                ComPtr<IUIAutomationTextRange> before, after;
                require(visible->Clone(&before)); require(visible->Clone(&after));
                reader.move(before.Get(), end, point, endpoint);
                reader.move(after.Get(), start, point, endpoint);
                if (reader.compare(before.Get(), start, visible, start) != 0 || reader.compare(after.Get(), end, visible, end) != 0)
                    throw std::runtime_error("terminal endpoint escaped viewport");
                const auto a = reader.text(before.Get(), limit), b = reader.text(after.Get(), limit);
                if (!a || !b || *a + *b != *value) return std::nullopt;
                return units(*a);
            };
            runs.push_back({{"id", i}, {"text", *value}, {"connected", i > 0 && reader.compare(ranges[i-1].Get(), end, visible, start) == 0},
                {"startKnown", false}, {"endKnown", false}});
            // GetVisibleRanges returns a degenerate range both for an empty
            // control and when all text is scrolled out. It is not caret geometry.
            if (caret && reader.compare(visible, start, visible, end) < 0 &&
                reader.compare(caret.Get(), start, visible, start) >= 0 && reader.compare(caret.Get(), end, visible, end) <= 0) {
                const auto place = offset(caret.Get(), start);
                anchor = place ? nlohmann::json{{"status", "exact"}, {"surface", id}, {"run", i}, {"offset", *place}}
                               : nlohmann::json{{"status", "unavailable"}};
            }
            for (size_t j = 0; j < selected.size(); ++j) {
                auto* selection = selected[j].Get();
                if (reader.compare(selection, start, selection, end) == 0) continue;
                if (reader.compare(selection, end, visible, start) <= 0 || reader.compare(selection, start, visible, end) >= 0) continue;
                ComPtr<IUIAutomationTextRange> intersection; require(selection->Clone(&intersection));
                if (reader.compare(intersection.Get(), start, visible, start) < 0) reader.move(intersection.Get(), start, visible, start);
                if (reader.compare(intersection.Get(), end, visible, end) > 0) reader.move(intersection.Get(), end, visible, end);
                completeSelection = completeSelection && reader.compare(covered[j].Get(), end, intersection.Get(), start) == 0;
                reader.move(covered[j].Get(), end, intersection.Get(), end);
                const auto from = offset(intersection.Get(), start), to = offset(intersection.Get(), end);
                if (from && to) selections.push_back({{"run", i}, {"start", *from}, {"end", *to}});
                else completeSelection = false;
            }
        }
        for (size_t i = 0; i < selected.size(); ++i)
            completeSelection = completeSelection && reader.compare(covered[i].Get(), end, selected[i].Get(), end) == 0;
        // The text is read once and kept, even if output arrives meanwhile (owner, 2026-10-05:
        // the screen as at key-down, rather than no screen at all).
        reader.check();
        return {{"surface", {{"id", id}, {"frame", {frame.x, frame.y, frame.width, frame.height}}, {"runs", runs},
            {"selection", {{"complete", completeSelection}, {"ranges", selections}}}}}, {"caret", anchor}};
    }
    // Caller has approved the entire field subtree. UIA positions stay opaque;
    // Rust owns whole eligibility, probe sizes, source edges and projection.
    static void appendField(IUIAutomationTextPattern* pattern, VisibleContext& context,
                            std::optional<ContextFrame> frame, ULONGLONG started) {
        UiaCaretSource reader(started);
        ComPtr<IUIAutomationTextRange> document;
        reader.check(); require(pattern->get_DocumentRange(&document)); reader.check();
        if (!document) throw std::runtime_error("field document unavailable");
        const auto limit = core::request({{"limits", true}}, voice_core_context_json).at("sourceWindowBytes").get<size_t>();
        const auto unchangedDocument = [&] {
            ComPtr<IUIAutomationTextRange> current;
            reader.check(); require(pattern->get_DocumentRange(&current)); reader.check();
            if (!current) return false;
            BOOL same = FALSE; require(document->Compare(current.Get(), &same)); reader.check(); return same != FALSE;
        };
        if (const auto whole = reader.text(document.Get(), limit);
            whole && core::request({{"fieldPlan", {{"text", *whole}}}}, voice_core_context_json).at("useWhole").get<bool>()) {
            if (!unchangedDocument() || reader.text(document.Get(), limit) != whole) throw std::runtime_error("field changed");
            context.appendField({"", *whole, ""}, frame);
            return;
        }
        const auto ranges = reader.visibleRanges(pattern, document.Get());
        auto candidate = context;
        for (const auto& visible : ranges) {
            if (candidate.textBudgetFull) break;
            const auto bounded = reader.boundedTarget(visible.Get(), limit);
            const auto& target = bounded.first;
            const auto& value = bounded.second;
            const auto before = reader.side(target.Get(), document.Get(), true, limit);
            const auto after = reader.side(target.Get(), document.Get(), false, limit);
            if (reader.text(target.Get(), limit) != std::optional<std::string>(value)) throw std::runtime_error("field changed");
            const auto parts = core::request({{"fieldWindow", {{"parts", std::array<std::string,3>{before.first, value, after.first}},
                {"startKnown", before.second}, {"endKnown", after.second}}}}, voice_core_context_json).at("parts").get<std::array<std::string,3>>();
            candidate.appendField(parts, frame);
        }
        const auto current = reader.visibleRanges(pattern, document.Get());
        if (!unchangedDocument() || current.size() != ranges.size()) throw std::runtime_error("field changed");
        for (size_t i = 0; i < ranges.size(); ++i) {
            BOOL same = FALSE; require(ranges[i]->Compare(current[i].Get(), &same)); reader.check();
            if (!same) throw std::runtime_error("field visibility changed");
        }
        context = std::move(candidate);
    }
    // Approved child captions have their own complete source domain. No text
    // outside that range may be used, even for recognition-only context.
    static std::string rangeSource(IUIAutomationTextRange* approved, ULONGLONG started) {
        UiaCaretSource reader(started);
        const auto limit = core::request({{"limits", true}}, voice_core_context_json).at("blockSourceBytes").get<size_t>();
        const auto [target, value] = reader.boundedTarget(approved, limit, true);
        const bool complete = reader.compare(target.Get(), TextPatternRangeEndpoint_End, approved, TextPatternRangeEndpoint_End) == 0;
        if (reader.text(target.Get(), limit) != std::optional<std::string>(value)) throw std::runtime_error("caption changed");
        return core::request({{"blockWindow", {{"text", value}, {"startKnown", true}, {"endKnown", complete}}}},
            voice_core_context_json).at("text").get<std::string>();
    }
    // The caller has approved only this selection's enclosing subtree. Never
    // read adjacent document text here or replace the approved range silently.
    static std::optional<std::string> selectedText(IUIAutomationTextPattern* pattern,
        IUIAutomationTextRange* approved, IUIAutomationTextRange* document, ULONGLONG started) {
        UiaCaretSource reader(started);
        if (!approved || !document || reader.compare(approved, TextPatternRangeEndpoint_Start, document, TextPatternRangeEndpoint_Start) < 0 ||
            reader.compare(approved, TextPatternRangeEndpoint_End, document, TextPatternRangeEndpoint_End) > 0) return std::nullopt;
        const auto unchanged = [&]() {
            auto current = reader.selection(pattern);
            ComPtr<IUIAutomationTextRange> currentDocument;
            reader.check(); require(pattern->get_DocumentRange(&currentDocument)); reader.check();
            if (!current || !currentDocument) return false;
            BOOL same = FALSE, sameDocument = FALSE;
            require(approved->Compare(current.Get(), &same));
            require(document->Compare(currentDocument.Get(), &sameDocument)); reader.check();
            return same && sameDocument;
        };
        if (!unchanged()) return std::nullopt;
        const auto limit = core::request({{"limits", true}}, voice_core_context_json).at("selectionSourceBytes").get<size_t>();
        const auto value = reader.text(approved, limit);
        if (!value || !unchanged() || reader.text(approved, limit) != value || !unchanged()) return std::nullopt;
        return value;
    }
private:
    ULONGLONG started, budget;
    explicit UiaCaretSource(ULONGLONG time, ULONGLONG limit = walk::limits().timeBudgetMilliseconds) : started(time), budget(limit) {}
    void check() const { if (GetTickCount64() - started > budget) throw std::runtime_error("screen context time budget"); }
    int compare(IUIAutomationTextRange* a, TextPatternRangeEndpoint ae, IUIAutomationTextRange* b, TextPatternRangeEndpoint be) const {
        check(); int result = 0; require(a->CompareEndpoints(ae, b, be, &result)); check(); return result;
    }
    void move(IUIAutomationTextRange* a, TextPatternRangeEndpoint ae, IUIAutomationTextRange* b, TextPatternRangeEndpoint be) const {
        check(); require(a->MoveEndpointByRange(ae, b, be)); check();
    }
    ComPtr<IUIAutomationTextRange> selection(IUIAutomationTextPattern* pattern) const {
        ComPtr<IUIAutomationTextRangeArray> ranges;
        check(); require(pattern->GetSelection(&ranges)); check();
        if (!ranges) return {};
        int count = 0; require(ranges->get_Length(&count));
        if (count != 1) return {};
        ComPtr<IUIAutomationTextRange> selected; require(ranges->GetElement(0, &selected)); check(); return selected;
    }
    bool containSelection(IUIAutomationTextRange* selected, IUIAutomationTextRange* document) const {
        const auto start = TextPatternRangeEndpoint_Start, end = TextPatternRangeEndpoint_End;
        const bool outside = compare(selected, start, document, start) < 0 || compare(selected, end, document, end) > 0;
        if (!outside) return true;
        // Chromium may normalize a collapsed end caret into the next page node.
        // A nonempty selection must never become a clipped, apparently complete one.
        if (compare(selected, start, selected, end) != 0) return false;
        if (compare(selected, start, document, start) < 0) {
            move(selected, start, document, start); move(selected, end, document, start);
        } else {
            move(selected, end, document, end); move(selected, start, document, end);
        }
        return true;
    }
    std::optional<std::string> text(IUIAutomationTextRange* range, size_t limit) const {
        check();
        struct Text { BSTR value = nullptr; ~Text() { SysFreeString(value); } } text;
        require(range->GetText(static_cast<int>(limit + 1), &text.value)); check();
        const auto length = text.value ? SysStringLen(text.value) : 0;
        if (length > limit + 1) throw std::runtime_error("provider exceeded text bound");
        if (length > limit) return std::nullopt;
        const auto value = utf8(text.value ? std::wstring(text.value, length) : std::wstring{});
        if (value.size() > limit) return std::nullopt;
        return value;
    }
    std::pair<ComPtr<IUIAutomationTextRange>, std::string> boundedTarget(IUIAutomationTextRange* approved, size_t limit, bool block = false) const {
        if (!approved || compare(approved, TextPatternRangeEndpoint_Start, approved, TextPatternRangeEndpoint_End) > 0)
            throw std::runtime_error("source range unavailable");
        ComPtr<IUIAutomationTextRange> target;
        check(); require(approved->Clone(&target)); check();
        if (!target) throw std::runtime_error("source range unavailable");
        auto value = text(target.Get(), limit);
        if (!value) {
            for (const auto amount : probes(block)) {
                move(target.Get(), TextPatternRangeEndpoint_End, approved, TextPatternRangeEndpoint_Start);
                int moved = 0;
                require(target->MoveEndpointByUnit(TextPatternRangeEndpoint_End, TextUnit_Character, amount, &moved)); check();
                if (compare(target.Get(), TextPatternRangeEndpoint_End, approved, TextPatternRangeEndpoint_End) > 0)
                    move(target.Get(), TextPatternRangeEndpoint_End, approved, TextPatternRangeEndpoint_End);
                if (compare(target.Get(), TextPatternRangeEndpoint_Start, approved, TextPatternRangeEndpoint_Start) != 0)
                    throw std::runtime_error("source anchor changed");
                value = text(target.Get(), limit);
                if (value) break;
            }
        }
        if (!value) throw std::runtime_error("bounded source unavailable");
        return {target, *value};
    }
    static std::vector<int> probes(bool block = false) {
        return core::request({{"opaqueProbes", true}, {"scope", block ? "block" : "field"}}, voice_core_context_json).at("amounts").get<std::vector<int>>();
    }
    std::vector<ComPtr<IUIAutomationTextRange>> visibleRanges(IUIAutomationTextPattern* pattern, IUIAutomationTextRange* document, std::optional<int> maximum = {}) const {
        ComPtr<IUIAutomationTextRangeArray> ranges;
        check(); require(pattern->GetVisibleRanges(&ranges)); check();
        if (!ranges) throw std::runtime_error("field visibility unavailable");
        int count = 0; require(ranges->get_Length(&count)); check();
        const auto limit = maximum.value_or(core::request({{"limits", true}}, voice_core_context_json).at("fieldRangeCount").get<int>());
        if (count < 0 || count > limit) throw std::runtime_error("invalid visible range count");
        std::vector<ComPtr<IUIAutomationTextRange>> result;
        for (int i = 0; i < count; ++i) {
            ComPtr<IUIAutomationTextRange> range; require(ranges->GetElement(i, &range)); check();
            if (!range || (document && (compare(range.Get(), TextPatternRangeEndpoint_Start, document, TextPatternRangeEndpoint_Start) < 0 ||
                compare(range.Get(), TextPatternRangeEndpoint_End, document, TextPatternRangeEndpoint_End) > 0)) ||
                compare(range.Get(), TextPatternRangeEndpoint_Start, range.Get(), TextPatternRangeEndpoint_End) > 0)
                throw std::runtime_error("invalid visible field range");
            result.push_back(std::move(range));
        }
        return result;
    }
    // What starts at the selection: a paragraph, a line, and the first bytes of that line, for the
    // core to tell an empty line (Chromium gives one no character: its caret sits where the
    // paragraph above ends, on a line holding only that break) from a soft-wrapped one. None when
    // the provider has no paragraphs or lines.
    std::optional<CaretSource::CaretStarts> starts(IUIAutomationTextRange* selected) const {
        const auto enclosing = [&](TextUnit unit) -> ComPtr<IUIAutomationTextRange> {
            ComPtr<IUIAutomationTextRange> range;
            check(); require(selected->Clone(&range)); check();
            if (!range) throw std::runtime_error("provider range unavailable");
            move(range.Get(), TextPatternRangeEndpoint_End, selected, TextPatternRangeEndpoint_Start);
            if (FAILED(range->ExpandToEnclosingUnit(unit))) return nullptr;
            check();
            return range;
        };
        const auto paragraph = enclosing(TextUnit_Paragraph), line = enclosing(TextUnit_Line);
        if (!paragraph || !line) {
            std::cerr << "debug caret start: paragraphs or lines unavailable\n";
            return std::nullopt;
        }
        const auto startsHere = [&](IUIAutomationTextRange* range) {
            return compare(range, TextPatternRangeEndpoint_Start, selected, TextPatternRangeEndpoint_Start) == 0;
        };
        const auto lineBytes = core::request({{"limits", true}}, voice_core_context_json).at("caretLineBytes").get<size_t>();
        CaretSource::CaretStarts starts{startsHere(paragraph.Get()), startsHere(line.Get()), text(line.Get(), lineBytes)};
        std::cerr << "debug caret start: paragraph " << starts.paragraph << ", line " << starts.line << '\n';
        return starts;
    }
    std::pair<std::string, bool> side(IUIAutomationTextRange* selected, IUIAutomationTextRange* document, bool before, size_t limit) const {
        const auto outer = before ? TextPatternRangeEndpoint_Start : TextPatternRangeEndpoint_End;
        const auto inner = before ? TextPatternRangeEndpoint_End : TextPatternRangeEndpoint_Start;
        const auto anchor = before ? TextPatternRangeEndpoint_Start : TextPatternRangeEndpoint_End;
        for (const int amount : probes()) {
            check(); ComPtr<IUIAutomationTextRange> range; require(selected->Clone(&range)); check();
            if (!range) throw std::runtime_error("provider range unavailable");
            move(range.Get(), inner, selected, anchor);
            int moved = 0; require(range->MoveEndpointByUnit(outer, TextUnit_Character, before ? -amount : amount, &moved)); check();
            const int edge = compare(range.Get(), outer, document, outer);
            if ((before && edge < 0) || (!before && edge > 0)) move(range.Get(), outer, document, outer);
            if (compare(range.Get(), inner, selected, anchor) != 0) throw std::runtime_error("provider changed caret anchor");
            if (const auto value = text(range.Get(), limit)) return {*value, compare(range.Get(), outer, document, outer) == 0};
        }
        return {"", false};
    }
};
}
