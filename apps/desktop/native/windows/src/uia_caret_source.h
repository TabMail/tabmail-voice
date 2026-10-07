// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include <windows.h>
#include <ole2.h>
#include <UIAutomation.h>
#include <algorithm>
#include <functional>
#include <iostream>
#include <vector>
#include "helper_config.h"
#include "com.h"
#include "text.h"
#include "../../shared/context/CaretSource.h"
#include "../../shared/context/screen_context.h"

namespace voice {
static_assert(HelperConfig::blockControlTypes[0] == UIA_GroupControlTypeId && HelperConfig::blockControlTypes[1] == UIA_ListControlTypeId &&
              HelperConfig::blockControlTypes[2] == UIA_ListItemControlTypeId && HelperConfig::blockControlTypes[3] == UIA_TableControlTypeId);
// UIA endpoints are opaque; Character may fall back to a larger supported unit.
// Validate actual returned text and endpoint relationships, never a moved count.
class UiaCaretSource {
public:
    // Where the field's blocks start near the selection (a range starting at each) and whether the
    // selection ends the line before one starting there: Chromium's text leaves out the break before
    // a block that follows text, and the core puts it back (ADR-DESK-007, 2026-10-06). None: not told.
    struct Layout { std::vector<ComPtr<IUIAutomationTextRange>> starts; bool caretEndsLine; };
    // Asked with the selection and the stretch around it to look in: from `low`'s start to `high`'s
    // end, the core's `paragraphStartUnits` on each side, as on the Mac.
    using LayoutRead = std::function<std::optional<Layout>(IUIAutomationTextRange* selected, IUIAutomationTextRange* low, IUIAutomationTextRange* high)>;
    static CaretSource read(IUIAutomationTextPattern* pattern, const LayoutRead& layout = {}) {
        UiaCaretSource reader;
        auto selected = reader.selection(pattern);
        ComPtr<IUIAutomationTextRange> document;
        require(pattern->get_DocumentRange(&document));
        if (!selected || !document || !reader.containSelection(selected.Get(), document.Get())) return CaretSource::unread(true);
        const auto limits = core::request({{"limits", true}}, voice_core_context_json);
        const auto selectionLimit = limits.at("selectionSourceBytes").get<size_t>();
        const auto sourceLimit = limits.at("sourceWindowBytes").get<size_t>();
        const auto selectionText = reader.text(selected.Get(), selectionLimit);
        if (!selectionText) return CaretSource::unread(true);
        const auto before = reader.side(selected.Get(), document.Get(), true, sourceLimit);
        const auto after = reader.side(selected.Get(), document.Get(), false, sourceLimit);
        std::optional<CaretSource::ParagraphStarts> paragraphs;
        if (layout) {
            const auto units = limits.at("paragraphStartUnits").get<int>();
            const auto low = reader.stretch(selected.Get(), document.Get(), true, units), high = reader.stretch(selected.Get(), document.Get(), false, units);
            if (const auto found = layout(selected.Get(), low.Get(), high.Get())) {
                if (const auto offsets = reader.offsets(found->starts, selected.Get(), low.Get(), {before.first, *selectionText, after.first}))
                    paragraphs = CaretSource::ParagraphStarts{*offsets, found->caretEndsLine};
            }
            std::cerr << "debug caret start: " << (paragraphs ? std::to_string(paragraphs->starts.size()) : std::string("no"))
                      << " block starts near the caret; the caret " << (paragraphs && paragraphs->caretEndsLine ? "ends a line" : "starts its text") << '\n';
        }
        // A provider that places its blocks says where paragraphs start, the caret's among them.
        const auto caretStarts = paragraphs ? std::nullopt : reader.starts(selected.Get());
        auto finalSelection = reader.selection(pattern);
        ComPtr<IUIAutomationTextRange> finalDocument;
        require(pattern->get_DocumentRange(&finalDocument));
        if (!finalSelection || !finalDocument || !reader.containSelection(finalSelection.Get(), finalDocument.Get())) return CaretSource::unread(!selectionText->empty());
        BOOL sameSelection = FALSE, sameDocument = FALSE;
        require(selected->Compare(finalSelection.Get(), &sameSelection));
        require(document->Compare(finalDocument.Get(), &sameDocument));
        if (!sameSelection || !sameDocument || reader.text(finalSelection.Get(), selectionLimit) != selectionText) return CaretSource::unread(!selectionText->empty());
        return CaretSource::window({before.first, *selectionText, after.first}, before.second, after.second, caretStarts, paragraphs);
    }
    // The field's blocks, from its own tree: which children are blocks, and where each child's text
    // is (`RangeFromChild`). Chromium's paragraphs are groups only the raw view holds, so a node's
    // children come in one call with a raw-view tree filter (a search's own view is the control view).
    // Measured in Chromium, not documented: the raw-view filter, and `RangeFromChild` on a field's
    // grandchildren. Where either answers nothing, a node has no children or no range, and where
    // the text disagrees, `offsets` gives no starts: the breaks are left out, as before. Any other
    // UI Automation call that fails fails the read, as everywhere else in the caret source.
    static LayoutRead layout(IUIAutomation* automation, IUIAutomationElement* field, IUIAutomationTextPattern* pattern) {
        return [automation, field, pattern](IUIAutomationTextRange* selected, IUIAutomationTextRange* low, IUIAutomationTextRange* high) -> std::optional<Layout> {
            using Node = ComPtr<IUIAutomationElement>;
            ComPtr<IUIAutomationCondition> raw;
            require(automation->get_RawViewCondition(&raw));
            ComPtr<IUIAutomationCacheRequest> cache;
            require(automation->CreateCacheRequest(&cache));
            require(cache->put_TreeFilter(raw.Get()));
            require(cache->AddProperty(UIA_ControlTypePropertyId));
            require(cache->AddProperty(UIA_HeadingLevelPropertyId));
            const auto children = [&](const Node& node) {
                std::vector<Node> result;
                ComPtr<IUIAutomationElementArray> found;
                if (FAILED(node->FindAllBuildCache(TreeScope_Children, raw.Get(), cache.Get(), &found)) || !found) return result;
                int count = 0; require(found->get_Length(&count));
                for (int i = 0; i < count; ++i) {
                    Node child; require(found->GetElement(i, &child));
                    if (child) result.push_back(std::move(child));
                }
                return result;
            };
            const auto isBlock = [](const Node& node) {
                CONTROLTYPEID type = 0;
                require(node->get_CachedControlType(&type));
                if (std::find(std::begin(HelperConfig::blockControlTypes), std::end(HelperConfig::blockControlTypes), type) != std::end(HelperConfig::blockControlTypes)) return true;
                if (type != UIA_TextControlTypeId) return false;
                VARIANT level; VariantInit(&level);
                const bool heading = SUCCEEDED(node->GetCachedPropertyValue(UIA_HeadingLevelPropertyId, &level)) && level.vt == VT_I4 && level.lVal != HeadingLevel_None;
                VariantClear(&level);
                return heading;
            };
            const auto place = [&](const Node& node) {
                ComPtr<IUIAutomationTextRange> range;
                if (FAILED(pattern->RangeFromChild(node.Get(), &range))) range.Reset();
                return range;
            };
            const auto elements = core::request({{"limits", true}}, voice_core_context_json).at("caretSourceElements").get<size_t>();
            auto starts = blockStarts(Node(field), low, high, elements, children, isBlock, place);
            if (!starts) return std::nullopt;
            // The element the selection's start is in tells the end of a line from the start of
            // the block after it.
            ComPtr<IUIAutomationTextRange> caret;
            require(selected->Clone(&caret));
            if (!caret) throw std::runtime_error("provider range unavailable");
            require(caret->MoveEndpointByRange(TextPatternRangeEndpoint_End, selected, TextPatternRangeEndpoint_Start));
            Node enclosing;
            BOOL isField = TRUE;
            if (SUCCEEDED(caret->GetEnclosingElement(&enclosing)) && enclosing) require(automation->CompareElements(enclosing.Get(), field, &isField));
            ComPtr<IUIAutomationTextRange> span;
            if (!isField) span = place(enclosing);
            return Layout{std::move(*starts), endsLine(span.Get(), selected)};
        };
    }
    // The ranges of the blocks near the selection, and of the nodes right after a block, as the Mac
    // finds them: the shared core walks the field (`blockStarts`, ADR-DESK-054) and decides which
    // node to place, which start a line and when the walk ends; this says how each placed node's
    // range compares with the window (`low`'s start to `high`'s end) and whether it is a block.
    // None when more than `elements` nodes would be placed, or one can't be.
    template <class Node, class Children, class IsBlock, class Place>
    static std::optional<std::vector<ComPtr<IUIAutomationTextRange>>> blockStarts(const Node& field, IUIAutomationTextRange* low, IUIAutomationTextRange* high,
        size_t elements, const Children& children, const IsBlock& isBlock, const Place& place) {
        const UiaCaretSource reader;
        const auto start = TextPatternRangeEndpoint_Start, end = TextPatternRangeEndpoint_End;
        const auto ask = [](const nlohmann::json& request) { return core::request({{"blockStarts", request}}, voice_core_context_json); };
        std::vector<ComPtr<IUIAutomationTextRange>> starts;
        ComPtr<IUIAutomationTextRange> placed;
        // The children of each node the walk is in, the field's first.
        std::vector<std::vector<Node>> path;
        const auto node = [&](const nlohmann::json& asked) -> Node {
            const auto depth = asked.at("depth").get<size_t>(), child = asked.at("child").get<size_t>();
            if (depth >= path.size() || child >= path[depth].size()) throw std::runtime_error("block walk asked for no node");
            path.resize(depth + 1);
            return path[depth][child];
        };
        auto reply = ask({{"start", {{"elements", elements}}}});
        while (true) {
            if (reply.value("start", false) && placed) starts.push_back(placed);
            if (reply.contains("done")) {
                if (!reply.at("done").get<bool>()) return std::nullopt;
                return starts;
            }
            const auto& asked = reply.at("ask");
            if (asked.contains("children")) {
                const auto& wanted = asked.at("children");
                Node parent = field;
                if (wanted.at("depth").is_null()) path.clear();
                else parent = node(wanted);
                path.push_back(children(parent));
                reply = ask({{"state", reply.at("state")}, {"children", path.back().size()}});
                continue;
            }
            const auto& wanted = asked.at("place");
            const auto element = node(wanted);
            placed = place(element);
            if (!placed) {
                reply = ask({{"state", reply.at("state")}, {"placed", nullptr}});
                continue;
            }
            // Each comparison is a call across processes: only those the walk's phase needs.
            nlohmann::json facts{{"block", isBlock(element)}};
            if (wanted.at("phase") == "halve") facts["endsBefore"] = reader.compare(placed.Get(), end, low, start) < 0;
            else {
                facts["startsPast"] = reader.compare(placed.Get(), start, high, end) > 0;
                facts["startsWithin"] = reader.compare(placed.Get(), start, low, start) >= 0;
            }
            reply = ask({{"state", reply.at("state")}, {"placed", facts}});
        }
    }
    // Whether a selection is at the end of the line its start's element (`span`) ends, not at the
    // start of the block after it: the text gives both places one offset (measured in Chromium,
    // 2026-10-06, as on the Mac). No element: it starts its text. The shared core decides.
    static bool endsLine(IUIAutomationTextRange* span, IUIAutomationTextRange* selected) {
        if (!span) return false;
        const UiaCaretSource reader;
        const auto start = TextPatternRangeEndpoint_Start, end = TextPatternRangeEndpoint_End;
        return core::request({{"blockStarts", {{"endsLine", {
            {"startsBefore", reader.compare(span, start, selected, start) < 0},
            {"reachesSelection", reader.compare(span, end, selected, start) >= 0}}}}}}, voice_core_context_json).at("endsLine").get<bool>();
    }
    // Caller proves privacy, visible provider identity and focus. Every GetText
    // stays inside an approved visible range. Do not constrain terminal ranges
    // to DocumentRange: Windows Terminal ends that range beneath its cursor or
    // last text, while GetVisibleRanges also includes the remaining blank rows.
    static nlohmann::json viewportSurface(IUIAutomationTextPattern* pattern, size_t id,
        ContextFrame frame, bool focused, size_t byteBudget) {
        UiaCaretSource reader;
        const auto start = TextPatternRangeEndpoint_Start, end = TextPatternRangeEndpoint_End;
        const auto limits = core::request({{"limits", true}}, voice_core_viewport_json);
        const size_t limit = std::min(byteBudget, limits.at("bytes").get<size_t>());
        const int rangeLimit = limits.at("runs").get<int>();
        const auto selectedRanges = [&] {
            ComPtr<IUIAutomationTextRangeArray> array;
            require(pattern->GetSelection(&array));
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
                BOOL active = FALSE;
                const HRESULT status = advanced->GetCaretRange(&active, &result);
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
        return {{"surface", {{"id", id}, {"frame", {frame.x, frame.y, frame.width, frame.height}}, {"runs", runs},
            {"selection", {{"complete", completeSelection}, {"ranges", selections}}}}}, {"caret", anchor}};
    }
    // Caller has approved the entire field subtree. UIA positions stay opaque;
    // Rust owns whole eligibility, probe sizes, source edges and projection.
    static void appendField(IUIAutomationTextPattern* pattern, VisibleContext& context,
                            std::optional<ContextFrame> frame) {
        UiaCaretSource reader;
        ComPtr<IUIAutomationTextRange> document;
        require(pattern->get_DocumentRange(&document));
        if (!document) throw std::runtime_error("field document unavailable");
        const auto limit = core::request({{"limits", true}}, voice_core_context_json).at("sourceWindowBytes").get<size_t>();
        const auto unchangedDocument = [&] {
            ComPtr<IUIAutomationTextRange> current;
            require(pattern->get_DocumentRange(&current));
            if (!current) return false;
            BOOL same = FALSE; require(document->Compare(current.Get(), &same)); return same != FALSE;
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
            BOOL same = FALSE; require(ranges[i]->Compare(current[i].Get(), &same));
            if (!same) throw std::runtime_error("field visibility changed");
        }
        context = std::move(candidate);
    }
    // Approved child captions have their own complete source domain. No text
    // outside that range may be used, even for recognition-only context.
    static std::string rangeSource(IUIAutomationTextRange* approved) {
        UiaCaretSource reader;
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
        IUIAutomationTextRange* approved, IUIAutomationTextRange* document) {
        UiaCaretSource reader;
        if (!approved || !document || reader.compare(approved, TextPatternRangeEndpoint_Start, document, TextPatternRangeEndpoint_Start) < 0 ||
            reader.compare(approved, TextPatternRangeEndpoint_End, document, TextPatternRangeEndpoint_End) > 0) return std::nullopt;
        const auto unchanged = [&]() {
            auto current = reader.selection(pattern);
            ComPtr<IUIAutomationTextRange> currentDocument;
            require(pattern->get_DocumentRange(&currentDocument));
            if (!current || !currentDocument) return false;
            BOOL same = FALSE, sameDocument = FALSE;
            require(approved->Compare(current.Get(), &same));
            require(document->Compare(currentDocument.Get(), &sameDocument));
            return same && sameDocument;
        };
        if (!unchanged()) return std::nullopt;
        const auto limit = core::request({{"limits", true}}, voice_core_context_json).at("selectionSourceBytes").get<size_t>();
        const auto value = reader.text(approved, limit);
        if (!value || !unchanged() || reader.text(approved, limit) != value || !unchanged()) return std::nullopt;
        return value;
    }
private:
    int compare(IUIAutomationTextRange* a, TextPatternRangeEndpoint ae, IUIAutomationTextRange* b, TextPatternRangeEndpoint be) const {
        int result = 0; require(a->CompareEndpoints(ae, b, be, &result)); return result;
    }
    void move(IUIAutomationTextRange* a, TextPatternRangeEndpoint ae, IUIAutomationTextRange* b, TextPatternRangeEndpoint be) const {
        require(a->MoveEndpointByRange(ae, b, be));
    }
    ComPtr<IUIAutomationTextRange> selection(IUIAutomationTextPattern* pattern) const {
        ComPtr<IUIAutomationTextRangeArray> ranges;
        require(pattern->GetSelection(&ranges));
        if (!ranges) return {};
        int count = 0; require(ranges->get_Length(&count));
        if (count != 1) return {};
        ComPtr<IUIAutomationTextRange> selected; require(ranges->GetElement(0, &selected)); return selected;
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
        struct Text { BSTR value = nullptr; ~Text() { SysFreeString(value); } } text;
        require(range->GetText(static_cast<int>(limit + 1), &text.value));
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
        require(approved->Clone(&target));
        if (!target) throw std::runtime_error("source range unavailable");
        auto value = text(target.Get(), limit);
        if (!value) {
            for (const auto amount : probes(block)) {
                move(target.Get(), TextPatternRangeEndpoint_End, approved, TextPatternRangeEndpoint_Start);
                int moved = 0;
                require(target->MoveEndpointByUnit(TextPatternRangeEndpoint_End, TextUnit_Character, amount, &moved));
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
        require(pattern->GetVisibleRanges(&ranges));
        if (!ranges) throw std::runtime_error("field visibility unavailable");
        int count = 0; require(ranges->get_Length(&count));
        const auto limit = maximum.value_or(core::request({{"limits", true}}, voice_core_context_json).at("fieldRangeCount").get<int>());
        if (count < 0 || count > limit) throw std::runtime_error("invalid visible range count");
        std::vector<ComPtr<IUIAutomationTextRange>> result;
        for (int i = 0; i < count; ++i) {
            ComPtr<IUIAutomationTextRange> range; require(ranges->GetElement(i, &range));
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
            require(selected->Clone(&range));
            if (!range) throw std::runtime_error("provider range unavailable");
            move(range.Get(), TextPatternRangeEndpoint_End, selected, TextPatternRangeEndpoint_Start);
            if (FAILED(range->ExpandToEnclosingUnit(unit))) return nullptr;
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
    // Each block start's byte offset into the parts joined, measured along the text: from where
    // `low` starts (placed by its text up to the selection, which ends the text before it), then from
    // each start to the next. No range measured starts at the selection: a caret at the end of a
    // paragraph is a place Chromium reads the paragraph's break from, even up to the start of the
    // block after it, though the text around the caret shows none (measured 2026-10-06). Each text
    // measured must be what the parts hold there; starts past the parts, and at their start, are
    // left out. None when the provider's text disagrees.
    std::optional<std::vector<size_t>> offsets(const std::vector<ComPtr<IUIAutomationTextRange>>& starts, IUIAutomationTextRange* selected,
        IUIAutomationTextRange* low, const std::array<std::string, 3>& parts) const {
        const auto start = TextPatternRangeEndpoint_Start, end = TextPatternRangeEndpoint_End;
        const auto joined = parts[0] + parts[1] + parts[2];
        ComPtr<IUIAutomationTextRange> between;
        require(low->Clone(&between));
        if (!between) throw std::runtime_error("provider range unavailable");
        move(between.Get(), end, selected, start);
        const auto lead = text(between.Get(), parts[0].size());
        if (!lead || !parts[0].ends_with(*lead)) return std::nullopt;
        size_t at = parts[0].size() - lead->size();
        std::vector<size_t> result;
        for (const auto& span : starts) {
            move(between.Get(), end, span.Get(), start);
            const auto value = text(between.Get(), joined.size() - at);
            if (!value) break;
            if (joined.compare(at, value->size(), *value) != 0) return std::nullopt;
            at += value->size();
            if (at) result.push_back(at);
            move(between.Get(), start, span.Get(), start);
        }
        std::sort(result.begin(), result.end());
        result.erase(std::unique(result.begin(), result.end()), result.end());
        return result;
    }
    // A range from the selection's start back `units` characters (`before`), or from its end on,
    // inside the document.
    ComPtr<IUIAutomationTextRange> stretch(IUIAutomationTextRange* selected, IUIAutomationTextRange* document, bool before, int units) const {
        const auto outer = before ? TextPatternRangeEndpoint_Start : TextPatternRangeEndpoint_End;
        const auto inner = before ? TextPatternRangeEndpoint_End : TextPatternRangeEndpoint_Start;
        ComPtr<IUIAutomationTextRange> range; require(selected->Clone(&range));
        if (!range) throw std::runtime_error("provider range unavailable");
        move(range.Get(), inner, selected, outer);
        int moved = 0; require(range->MoveEndpointByUnit(outer, TextUnit_Character, before ? -units : units, &moved));
        const int edge = compare(range.Get(), outer, document, outer);
        if ((before && edge < 0) || (!before && edge > 0)) move(range.Get(), outer, document, outer);
        return range;
    }
    std::pair<std::string, bool> side(IUIAutomationTextRange* selected, IUIAutomationTextRange* document, bool before, size_t limit) const {
        const auto outer = before ? TextPatternRangeEndpoint_Start : TextPatternRangeEndpoint_End;
        const auto inner = before ? TextPatternRangeEndpoint_End : TextPatternRangeEndpoint_Start;
        const auto anchor = before ? TextPatternRangeEndpoint_Start : TextPatternRangeEndpoint_End;
        for (const int amount : probes()) {
            ComPtr<IUIAutomationTextRange> range; require(selected->Clone(&range));
            if (!range) throw std::runtime_error("provider range unavailable");
            move(range.Get(), inner, selected, anchor);
            int moved = 0; require(range->MoveEndpointByUnit(outer, TextUnit_Character, before ? -amount : amount, &moved));
            const int edge = compare(range.Get(), outer, document, outer);
            if ((before && edge < 0) || (!before && edge > 0)) move(range.Get(), outer, document, outer);
            if (compare(range.Get(), inner, selected, anchor) != 0) throw std::runtime_error("provider changed caret anchor");
            if (const auto value = text(range.Get(), limit)) return {*value, compare(range.Get(), outer, document, outer) == 0};
        }
        return {"", false};
    }
};
}
