// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include "../../shared/context/SemanticText.h"
#include "../../shared/context/CaretSource.h"
#include "accessibility.h"
#include "privacy.h"
#include "identity.h"
#include "../../shared/privacy/ScreenPrivacy.h"
#include "../../shared/context/screen_context.h"
#include "../../shared/context/walk.h"
#include "hypertext.h"
#include <array>
#include <cmath>
#include <iostream>
#include <limits>
#include <optional>

namespace voice {
struct ScreenBudgetExceeded : std::runtime_error { ScreenBudgetExceeded() : std::runtime_error("screen time budget") {} };
// AT-SPI offsets count Unicode characters, not UTF-8 bytes. A short answer
// can mean the document changed; never publish it as a complete requested range.
inline bool completeProviderRange(const char* value, int from, int to) {
    return from >= 0 && to >= from && value && g_utf8_validate(value, -1, nullptr) &&
        g_utf8_strlen(value, -1) == static_cast<glong>(to) - from;
}
using CaretText = CaretSource;
class LiveScreenTree {
public:
    using Node = voice::Node;
    // Longest a field read for corrections may take (ms); the app asks for one every half second
    // while it watches the field.
    static constexpr unsigned fieldReadMilliseconds = 1500;
    // `milliseconds`: how long the read may take. A screen read has none: it runs while the user
    // speaks, in voice-screen-reader, a program of its own, so it holds up nothing else; a
    // dictation uses it only if it is done in time, and the app ends that process when the read
    // is no longer wanted.
    explicit LiveScreenTree(const Node& root, std::optional<unsigned> milliseconds = std::nullopt) {
        // A browser can publish its tree after our client first sees the window.
        // Refresh cached descendants for each read, including correction learning.
        atspi_accessible_clear_cache(root.get());
        if (milliseconds) deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(*milliseconds);
    }
    bool same(const Node& first, const Node& second) { return voice::same(first, second); }
    bool withinBudget() const { return !deadline || std::chrono::steady_clock::now() < *deadline; }
    AtspiRole role(const Node& node) { check(); return voice::role(node); }
    bool isPassword(const Node& node) { return role(node) == ATSPI_ROLE_PASSWORD_TEXT; }
    std::vector<Node> children(const Node& node, size_t limit) { check(); return voice::children(node, limit); }
    bool editable(const Node& node) { check(); return state(node, ATSPI_STATE_EDITABLE); }
    bool shown(const Node& node) { check(); return state(node, ATSPI_STATE_SHOWING); }
    std::optional<PageHost> page(const Node& node) {
        if (role(node) != ATSPI_ROLE_DOCUMENT_WEB && role(node) != ATSPI_ROLE_DOCUMENT_FRAME) return {};
        check();
        auto document = own(atspi_accessible_get_document_iface(node.get()));
        if (!document) return PageHost{};
        Error error;
        auto attributes = atspi_document_get_document_attributes(document.get(), &error.value);
        std::unique_ptr<GHashTable, decltype(&g_hash_table_unref)> owned(attributes, &g_hash_table_unref);
        if (error.value || !attributes) return PageHost{};
        // An answered attribute list establishes absence; an unavailable list does not.
        auto value = static_cast<const char*>(g_hash_table_lookup(attributes, "DocURL"));
        if (!value) value = static_cast<const char*>(g_hash_table_lookup(attributes, "URI"));
        return hostOfAddress(value ? std::string(value) : std::string{});
    }
    // Collection performs the role census in the provider, avoiding one D-Bus
    // round trip per descendant. Keep the ordinary walk for other providers.
    std::optional<std::vector<Node>> privacyNodes(const Node& node) {
        check();
        auto collection = own(atspi_accessible_get_collection_iface(node.get()));
        if (!collection) return {};
        auto roles = g_array_new(FALSE, FALSE, sizeof(AtspiRole));
        std::unique_ptr<GArray, decltype(&g_array_unref)> ownedRoles(roles, &g_array_unref);
        const AtspiRole wanted[] = {ATSPI_ROLE_DOCUMENT_WEB, ATSPI_ROLE_DOCUMENT_FRAME, ATSPI_ROLE_PASSWORD_TEXT};
        g_array_append_vals(roles, wanted, 3);
        auto rule = own(atspi_match_rule_new(nullptr, ATSPI_Collection_MATCH_ALL,
            nullptr, ATSPI_Collection_MATCH_ALL, roles, ATSPI_Collection_MATCH_ANY,
            nullptr, ATSPI_Collection_MATCH_ALL, FALSE));
        Error error;
        auto matches = atspi_collection_get_matches(collection.get(), rule.get(),
            ATSPI_Collection_SORT_ORDER_CANONICAL, static_cast<gint>(walk::limits().nodeBudget + 1), TRUE, &error.value);
        std::unique_ptr<GArray, decltype(&g_array_unref)> ownedMatches(matches, &g_array_unref);
        std::vector<Node> result{node}; // Collection returns descendants, not its root.
        if (matches) for (guint i = 0; i < matches->len; ++i)
            result.push_back(own(g_array_index(matches, AtspiAccessible*, i)));
        if (error.value || !matches) return {};
        check();
        return result;
    }
    std::optional<ContextFrame> frame(const Node& node) {
        check();
        auto component = own(atspi_accessible_get_component_iface(node.get()));
        if (!component) return {};
        Error error;
        auto rectangle = atspi_component_get_extents(component.get(), ATSPI_COORD_TYPE_WINDOW, &error.value);
        std::unique_ptr<AtspiRect, decltype(&g_free)> owned(rectangle, &g_free);
        if (error.value || !rectangle) return {};
        return ContextFrame{static_cast<double>(rectangle->x), static_cast<double>(rectangle->y),
            static_cast<double>(rectangle->width), static_cast<double>(rectangle->height)};
    }
    std::string label(const Node& node) {
        check(); Error error;
        auto name = atspi_accessible_get_name(node.get(), &error.value);
        std::unique_ptr<gchar, decltype(&g_free)> owned(name, &g_free);
        error.check();
        if (!name) return {};
        if (!g_utf8_validate(name, -1, nullptr)) throw std::runtime_error("invalid provider label");
        const auto count = static_cast<size_t>(g_utf8_strlen(name, -1));
        return readScalarBlock(count, [&](size_t from, size_t to) {
            check();
            const auto begin = g_utf8_offset_to_pointer(name, static_cast<glong>(from));
            const auto end = g_utf8_offset_to_pointer(begin, static_cast<glong>(to - from));
            return std::string(begin, end);
        }).text;
    }
    std::optional<std::string> field(const Node& node, int maxLength) {
        check();
        auto text = own(atspi_accessible_get_text_iface(node.get()));
        if (!text) return {};
        Error error;
        const auto count = atspi_text_get_character_count(text.get(), &error.value);
        error.check();
        if (count < 0) return {};
        if (const auto rich = hypertext(node)) {
            if (!rich->complete || rich->length > static_cast<size_t>(maxLength)) return {};
            return rich->text;
        }
        if (count > maxLength) return {};
        return range(text, 0, count);
    }
    std::optional<std::string> screenText(const Node& node) {
        check();
        auto text = own(atspi_accessible_get_text_iface(node.get()));
        if (!text) return {};
        const auto characterCount = [&] {
            check(); Error error;
            const auto count = atspi_text_get_character_count(text.get(), &error.value);
            error.check(); check();
            if (count < 0) throw std::runtime_error("invalid text count");
            return count;
        };
        if (const auto rich = hypertext(node)) {
            if (!rich->complete) return {};
            return readScalarBlock(rich->length, [&](size_t from, size_t to) { return scalarSlice(rich->text, from, to); }).text;
        }
        const auto count = characterCount();
        const auto result = readScalarBlock(count, [&](size_t from, size_t to) {
            if (characterCount() != count) throw std::runtime_error("static text changed");
            return range(text, static_cast<int>(from), static_cast<int>(to));
        });
        if (characterCount() != count) throw std::runtime_error("static text changed");
        return result.text;
    }
    // Caller has approved the complete subtree before any text-bearing API.
    void appendFieldSource(const Node& node, const std::optional<ContextFrame>& window,
                           VisibleContext& context, const std::optional<ContextFrame>& geometry) {
        check();
        auto text = own(atspi_accessible_get_text_iface(node.get()));
        if (!text) return;
        const auto characterCount = [&] {
            check(); Error error;
            const auto count = atspi_text_get_character_count(text.get(), &error.value);
            error.check(); check();
            if (count < 0) throw std::runtime_error("invalid field count");
            return count;
        };
        // A rich editor's text is read whole, or not at all: its embedded elements have no
        // visible ranges of the field's own.
        if (const auto rich = hypertext(node)) {
            if (!rich->complete) return;
            const auto whole = readScalarField(rich->length, 0, rich->length, [&](size_t from, size_t to) { return scalarSlice(rich->text, from, to); });
            if (whole.complete && core::request({{"fieldPlan", {{"text", whole.text}}}}, voice_core_context_json).at("useWhole").get<bool>())
                context.appendField({"", whole.text, ""}, geometry);
            return;
        }
        const auto count = characterCount();
        const auto read = [&](size_t from, size_t to) {
            if (characterCount() != count) throw std::runtime_error("field changed");
            return range(text, static_cast<int>(from), static_cast<int>(to));
        };
        if (core::request({{"fieldPlan", {{"count", count}}}}, voice_core_context_json).at("probeWhole").get<bool>()) {
            const auto whole = readScalarField(count, 0, count, read);
            if (whole.complete && core::request({{"fieldPlan", {{"text", whole.text}}}}, voice_core_context_json).at("useWhole").get<bool>()) {
                if (characterCount() != count || !shown(node)) throw std::runtime_error("field changed");
                context.appendField({"", whole.text, ""}, geometry);
                return;
            }
        }
        if (!window || !geometry) return;
        const auto left = std::max(window->x, geometry->x), top = std::max(window->y, geometry->y);
        const auto right = std::min(window->x + window->width, geometry->x + geometry->width);
        const auto bottom = std::min(window->y + window->height, geometry->y + geometry->height);
        for (const auto coordinate : {left, top, right, bottom, right - left, bottom - top})
            if (!std::isfinite(coordinate) || coordinate < std::numeric_limits<int>::min() || coordinate > std::numeric_limits<int>::max())
                throw std::runtime_error("invalid field geometry");
        if (right <= left || bottom <= top) return;
        const auto visibleRanges = [&] {
            check(); Error error;
            // Unlike a range-only API, AT-SPI returns content too. The privacy
            // census must precede this call. Discard content without copying it;
            // exact bounded GetText calls below feed the common source planner.
            auto ranges = atspi_text_get_bounded_ranges(text.get(), static_cast<int>(left), static_cast<int>(top),
                static_cast<int>(right - left), static_cast<int>(bottom - top), ATSPI_COORD_TYPE_WINDOW,
                ATSPI_TEXT_CLIP_NONE, ATSPI_TEXT_CLIP_NONE, &error.value);
            const auto release = [](GArray* array) {
                if (!array) return;
                for (guint i = 0; i < array->len; ++i) g_free(g_array_index(array, AtspiTextRange, i).content);
                g_array_unref(array);
            };
            std::unique_ptr<GArray, decltype(release)> owned(ranges, release);
            error.check(); check();
            if (!ranges) throw std::runtime_error("field visibility unavailable");
            const auto limit = core::request({{"limits", true}}, voice_core_context_json).at("fieldRangeCount").get<size_t>();
            if (ranges->len > limit) throw std::runtime_error("too many field ranges");
            auto spans = nlohmann::json::array();
            for (guint i = 0; i < ranges->len; ++i) {
                const auto& span = g_array_index(ranges, AtspiTextRange, i);
                spans.push_back({span.start_offset, span.end_offset});
            }
            return core::request({{"fieldRanges", {{"count", count}, {"ranges", spans}}}}, voice_core_context_json)
                .at("ranges").get<std::vector<std::array<size_t, 2>>>();
        };
        const auto spans = visibleRanges();
        auto candidate = context;
        for (const auto& span : spans) {
            if (candidate.textBudgetFull) break;
            const auto projected = readScalarVisibleField(count, span[0], span[1], read);
            candidate.appendField(projected.parts, geometry);
        }
        // Commit the field atomically only after provider metadata still agrees.
        if (characterCount() != count || !shown(node) || visibleRanges() != spans)
            throw std::runtime_error("field visibility changed");
        context = std::move(candidate);
    }
    // Caller approves privacy and clips the provider's content viewport before
    // this text-bearing API. Offsets remain AT-SPI scalars until shared Rust.
    nlohmann::json viewportSurface(const Node& node, size_t id, const ContextFrame& clip,
                                   bool focused, size_t byteBudget) {
        check(); auto text = own(atspi_accessible_get_text_iface(node.get()));
        if (!text) throw std::runtime_error("terminal text unavailable");
        const auto limits = core::request({{"limits", true}}, voice_core_viewport_json);
        const size_t limit = std::min(byteBudget, limits.at("bytes").get<size_t>());
        const size_t rangeLimit = limits.at("runs").get<size_t>();
        const auto countNow = [&] { check(); Error error; const int count = atspi_text_get_character_count(text.get(), &error.value); error.check(); check();
            if (count < 0) throw std::runtime_error("terminal count");
            return count; };
        const int count = countNow();
        const auto selectionsNow = [&] {
            check(); Error error; const int total = atspi_text_get_n_selections(text.get(), &error.value); error.check();
            if (total < 0 || static_cast<size_t>(total) > rangeLimit) throw std::runtime_error("terminal selection count");
            std::vector<std::array<int,2>> result;
            for (int i=0;i<total;++i) {
                check(); auto value = atspi_text_get_selection(text.get(), i, &error.value);
                std::unique_ptr<AtspiRange, decltype(&g_free)> owned(value, &g_free); error.check();
                if (!value) throw std::runtime_error("terminal selection range");
                // The shared core withholds a selection that does not fit the text.
                result.push_back({value->start_offset,value->end_offset});
            }
            return result;
        };
        const auto caretNow = [&] { check(); Error error; const int caret = atspi_text_get_caret_offset(text.get(), &error.value); error.check(); check(); return caret; };
        const auto selected = selectionsNow(); const int caret = caretNow();
        for (double coordinate : {clip.x,clip.y,clip.width,clip.height})
            if (!std::isfinite(coordinate) || coordinate < std::numeric_limits<int>::min() || coordinate > std::numeric_limits<int>::max())
                throw std::runtime_error("terminal geometry");
        if (clip.width <= 0 || clip.height <= 0) throw std::runtime_error("terminal viewport empty");
        // GTK4 terminals (Ptyxis) answer no bounded ranges: the visible text is then the whole
        // lines under the viewport's top-left and bottom-left points.
        const auto spansAtPoints = [&]() -> std::vector<std::array<int,2>> {
            const auto offsetAt = [&](double x, double y) {
                check(); Error error;
                const int offset = atspi_text_get_offset_at_point(text.get(), static_cast<int>(x), static_cast<int>(y), ATSPI_COORD_TYPE_WINDOW, &error.value);
                error.check(); check(); return offset;
            };
            const auto line = [&](int offset) {
                check(); Error error;
                const auto release = [](AtspiTextRange* value) { if (value) { g_free(value->content); g_free(value); } };
                std::unique_ptr<AtspiTextRange,decltype(release)> value(
                    atspi_text_get_string_at_offset(text.get(), offset, ATSPI_TEXT_GRANULARITY_LINE, &error.value), release);
                error.check(); check();
                if (!value || value->start_offset < 0 || value->end_offset < value->start_offset) throw std::runtime_error("terminal line unavailable");
                return std::array<int,2>{value->start_offset, std::min(value->end_offset, count)};
            };
            const int top = offsetAt(clip.x + 1, clip.y + 1);
            if (top < 0 || top > count) throw std::runtime_error("terminal visible range");
            // The last line with text in the viewport: the bottom point can miss (padding, a partial
            // row, the empty rows below the last output), so a row higher at a time, never below the
            // viewport, where newer output of a scrolled-back terminal was never on the screen.
            const int rowHeight = [&] {
                check(); Error error;
                auto rectangle = atspi_text_get_character_extents(text.get(), top, ATSPI_COORD_TYPE_WINDOW, &error.value);
                std::unique_ptr<AtspiRect, decltype(&g_free)> owned(rectangle, &g_free); check();
                if (error.value || !rectangle || rectangle->height <= 0) throw std::runtime_error("terminal row height");
                return rectangle->height;
            }();
            int bottom = -1;
            for (double y = clip.y + clip.height - 1; y > clip.y + 1 && (bottom < 0 || bottom > count); y -= rowHeight)
                bottom = offsetAt(clip.x + 1, y);
            if (bottom < 0 || bottom > count) bottom = top;
            const auto first = line(top), last = bottom < count ? line(bottom) : std::array<int,2>{count, count};
            if (last[1] < first[0]) throw std::runtime_error("terminal visible range");
            return {{first[0], last[1]}};
        };
        const auto spansNow = [&] {
            check(); Error error;
            auto values = atspi_text_get_bounded_ranges(text.get(), static_cast<int>(clip.x), static_cast<int>(clip.y),
                static_cast<int>(clip.width), static_cast<int>(clip.height), ATSPI_COORD_TYPE_WINDOW,
                ATSPI_TEXT_CLIP_NONE, ATSPI_TEXT_CLIP_NONE, &error.value);
            const auto release = [](GArray* array) { if (!array) return;
                for (guint i=0;i<array->len;++i) g_free(g_array_index(array,AtspiTextRange,i).content);
                g_array_unref(array); };
            std::unique_ptr<GArray,decltype(release)> owned(values,release); check();
            if (error.value || !values || (values->len == 0 && count > 0)) {
                std::cerr << "debug screen: terminal has no bounded ranges, reading the lines at the viewport's corners\n";
                return spansAtPoints();
            }
            if (values->len > rangeLimit) throw std::runtime_error("terminal visible ranges");
            std::vector<std::array<int,2>> result;
            for(guint i=0;i<values->len;++i) {
                const auto& value=g_array_index(values,AtspiTextRange,i);
                if(value.start_offset<0 || value.end_offset<value.start_offset || value.end_offset>count ||
                    (!result.empty() && result.back()[1]>value.start_offset)) throw std::runtime_error("terminal visible range");
                result.push_back({value.start_offset,value.end_offset});
            }
            return result;
        };
        const auto spans=spansNow();
        // VTE can encode a scrolled-away cursor as visible-text start/end.
        // Those boundary positions lack independent visible insertion proof.
        nlohmann::json caretRead=nullptr;
        if(focused && caret>0 && caret<count) {
            check(); Error error; auto rectangle=atspi_text_get_character_extents(text.get(),caret,ATSPI_COORD_TYPE_WINDOW,&error.value);
            std::unique_ptr<AtspiRect,decltype(&g_free)> owned(rectangle,&g_free);
            if(!error.value && rectangle && rectangle->width>=0 && rectangle->height>0)
                caretRead={{"offset",caret},{"frame",{rectangle->x,rectangle->y,rectangle->width,rectangle->height}}};
        }
        // A character is at least one UTF-8 byte, so no more characters are read than the budget has
        // bytes; the shared core checks the bytes.
        auto spanList=nlohmann::json::array(), texts=nlohmann::json::array(), selections=nlohmann::json::array();
        size_t remaining=limit;
        for(const auto& span:spans) {
            const auto length=static_cast<size_t>(span[1]-span[0]);
            if(length > remaining) throw std::runtime_error("terminal source budget");
            auto value=readScalarField(length,0,length,[&](size_t from,size_t to){
                return range(text,span[0]+static_cast<int>(from),span[0]+static_cast<int>(to));
            });
            if(!value.complete || value.text.size()>remaining) throw std::runtime_error("terminal source incomplete");
            remaining-=value.text.size(); spanList.push_back({span[0],span[1]}); texts.push_back(std::move(value.text));
        }
        for(const auto& value:selected) selections.push_back({value[0],value[1]});
        // Read once and kept, even if output arrives meanwhile (owner, 2026-10-05: the screen as at key-down).
        check();
        // The runs, the selection and the caret are the shared core's (`surface-cases.json`).
        return core::request({{"surface",{{"id",id},{"frame",{clip.x,clip.y,clip.width,clip.height}},{"offsetUnit","scalar"},
            {"count",count},{"startKnown",false},{"endKnown",false},{"bytes",limit},{"spans",spanList},{"texts",texts},
            {"selections",selections},{"caret",caretRead}}}}, voice_core_viewport_json);
    }
    std::optional<CaretText> selection(const Node& node) {
        check();
        auto text = own(atspi_accessible_get_text_iface(node.get()));
        if (!text) return {};
        const auto snapshot = [&]() -> std::optional<std::array<int, 4>> {
            Error error; check();
            const auto count = atspi_text_get_character_count(text.get(), &error.value); error.check(); check();
            const auto selections = atspi_text_get_n_selections(text.get(), &error.value); error.check();
            if (count < 0 || selections < 0 || selections > 1) return {};
            if (!selections) return std::array<int, 4>{count, 0, 0, 0};
            check();
            auto selected = atspi_text_get_selection(text.get(), 0, &error.value);
            std::unique_ptr<AtspiRange, decltype(&g_free)> owned(selected, &g_free);
            error.check();
            if (!selected || selected->start_offset < 0 || selected->end_offset < selected->start_offset ||
                selected->end_offset > count) return {};
            return std::array<int, 4>{count, selections, selected->start_offset, selected->end_offset};
        };
        const auto initial = snapshot();
        if (!initial) return CaretText::unread(true);
        const auto from = (*initial)[2], to = (*initial)[3];
        // The selected interval is the entire source domain: Rust cannot request
        // adjacent terminal text. Native code only translates scalar offsets.
        CaretText result;
        try {
            result = readScalarCaret(to - from, 0, to - from, [&](size_t begin, size_t end) {
                if (snapshot() != initial) throw std::runtime_error("provider selection changed");
                return range(text, from + static_cast<int>(begin), from + static_cast<int>(end));
            });
        } catch (const ScreenBudgetExceeded&) { throw; }
        catch (const std::exception&) { return CaretText::unread(from < to); }
        const auto final = snapshot();
        check();
        if (final != initial || !state(node, ATSPI_STATE_FOCUSED)) return CaretText::unread(from < to);
        check();
        return result;
    }
    std::optional<CaretText> caret(const Node& node) {
        check();
        auto text = own(atspi_accessible_get_text_iface(node.get()));
        if (!text) return {};
        const auto snapshot = [&]() -> std::optional<std::array<int, 5>> {
            Error error; check();
            const auto count = atspi_text_get_character_count(text.get(), &error.value); error.check(); check();
            const auto offset = atspi_text_get_caret_offset(text.get(), &error.value); error.check(); check();
            const auto selections = atspi_text_get_n_selections(text.get(), &error.value); error.check();
            if (count < 0 || offset < 0 || offset > count || selections < 0 || selections > 1) return {};
            int from = offset, to = offset;
            if (selections) {
                check();
                auto selected = atspi_text_get_selection(text.get(), 0, &error.value);
                std::unique_ptr<AtspiRange, decltype(&g_free)> owned(selected, &g_free);
                error.check();
                if (!selected) return {};
                from = selected->start_offset; to = selected->end_offset;
                if (from < 0 || to < from || to > count) return {};
            }
            return std::array<int, 5>{count, offset, selections, from, to};
        };
        const auto initial = snapshot();
        if (!initial) return CaretText::unread(true);
        // A caret (no selection, or an empty one) selects nothing.
        const bool selectsText = (*initial)[3] < (*initial)[4];
        // Only a rich editor's caret is read through its elements: a page in focus (Chromium gives its
        // document hypertext too) is read by its own text, as any element, not walked element by element.
        if (hasLinks(node) && editable(node)) {
            const auto rich = hypertext(node);
            if (!rich || !rich->complete) return CaretText::unread(selectsText);
            const auto [count, offset, selections, from, to] = *initial;
            (void)count; (void)offset;
            // A selection the elements' parts lost is not read as none.
            if (selections && from < to && rich->selection && rich->selection->first == rich->selection->second) return CaretText::unread(true);
            // The root's selection is in its own offsets; the elements' own parts place it.
            std::optional<std::pair<size_t, size_t>> range;
            if (selections && rich->selection) range = rich->selection;
            else if (!selections && rich->caret) range = std::pair{*rich->caret, *rich->caret};
            if (!range) return CaretText::unread(selectsText);
            const auto result = readScalarCaret(rich->length, range->first, range->second,
                [&](size_t begin, size_t end) { return scalarSlice(rich->text, begin, end); });
            const auto final = snapshot();
            check();
            if (!final || *final != *initial || !state(node, ATSPI_STATE_FOCUSED)) return CaretText::unread(selectsText);
            return result;
        }
        const auto [count, offset, selections, from, to] = *initial;
        // The provider owns scalar offsets and transport; Rust owns every range,
        // byte budget, selection refusal and incomplete-edge decision.
        const auto result = readScalarCaret(count, from, to, [&](size_t begin, size_t end) {
            return range(text, static_cast<int>(begin), static_cast<int>(end));
        });
        const auto final = snapshot();
        check();
        if (!final || *final != *initial || !state(node, ATSPI_STATE_FOCUSED)) return CaretText::unread(selectsText);
        check();
        return result;
    }

private:
    // An element whose text holds embedded objects (a rich editor's paragraphs and links).
    bool hasLinks(const Node& node) {
        check();
        auto links = own(atspi_accessible_get_hypertext_iface(node.get()));
        if (!links) return false;
        Error error;
        const int count = atspi_hypertext_get_n_links(links.get(), &error.value);
        error.check(); check();
        return count > 0;
    }
    struct HypertextSource {
        using Node = voice::Node;
        LiveScreenTree& tree;
        std::optional<std::string> text(const Node& node, size_t bytes) {
            auto text = own(atspi_accessible_get_text_iface(node.get()));
            if (!text) return std::string();
            tree.check(); Error error;
            const auto count = atspi_text_get_character_count(text.get(), &error.value);
            error.check();
            if (count < 0) throw std::runtime_error("invalid text count");
            // Each scalar is at least a byte: more of them than `bytes` are not asked for.
            if (static_cast<size_t>(count) > bytes) return {};
            return tree.range(text, 0, count);
        }
        bool same(const Node& first, const Node& second) { return tree.same(first, second); }
        int caret(const Node& node) {
            auto text = own(atspi_accessible_get_text_iface(node.get()));
            if (!text) return -1;
            tree.check(); Error error;
            const auto offset = atspi_text_get_caret_offset(text.get(), &error.value);
            error.check(); tree.check();
            return offset;
        }
        std::optional<std::pair<int, int>> selection(const Node& node) {
            auto text = own(atspi_accessible_get_text_iface(node.get()));
            if (!text) return {};
            tree.check(); Error error;
            const auto count = atspi_text_get_n_selections(text.get(), &error.value);
            error.check();
            if (count == 0) return {};
            if (count != 1) throw std::runtime_error("hypertext selection count");
            auto range = atspi_text_get_selection(text.get(), 0, &error.value);
            std::unique_ptr<AtspiRange, decltype(&g_free)> owned(range, &g_free);
            error.check(); tree.check();
            if (!range || range->start_offset < 0 || range->end_offset < range->start_offset) throw std::runtime_error("hypertext selection");
            return std::pair{range->start_offset, range->end_offset};
        }
        std::optional<std::vector<std::pair<int, Node>>> links(const Node& node, size_t most) {
            std::vector<std::pair<int, Node>> result;
            auto links = own(atspi_accessible_get_hypertext_iface(node.get()));
            if (!links) return result;
            tree.check(); Error error;
            const int count = atspi_hypertext_get_n_links(links.get(), &error.value);
            error.check();
            if (count < 0) throw std::runtime_error("hypertext link count");
            if (static_cast<size_t>(count) > most) return {};
            for (int i = 0; i < count; ++i) {
                tree.check();
                auto link = own(atspi_hypertext_get_link(links.get(), i, &error.value));
                error.check();
                if (!link) throw std::runtime_error("hypertext link unavailable");
                const int start = atspi_hyperlink_get_start_index(link.get(), &error.value);
                error.check();
                auto child = own(atspi_hyperlink_get_object(link.get(), 0, &error.value));
                error.check();
                if (!child || start < 0) throw std::runtime_error("hypertext link unavailable");
                result.emplace_back(start, std::move(child));
            }
            std::sort(result.begin(), result.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
            return result;
        }
        // A block element starts a line of its own; a link or image joins its line.
        bool block(const Node& node) {
            tree.check(); Error error;
            auto attributes = atspi_accessible_get_attributes(node.get(), &error.value);
            std::unique_ptr<GHashTable, decltype(&g_hash_table_unref)> owned(attributes, &g_hash_table_unref);
            error.check();
            if (const auto display = attributes ? static_cast<const char*>(g_hash_table_lookup(attributes, "display")) : nullptr)
                return !g_str_has_prefix(display, "inline");
            const auto kind = tree.role(node);
            return kind != ATSPI_ROLE_LINK && kind != ATSPI_ROLE_IMAGE;
        }
    };
    // A rich editor's text, its caret and selection placed (hypertext.h); none for any other element.
    // One the read can't take (too many elements or bytes, or malformed) is not read, and the rest of
    // the screen is.
    std::optional<Hypertext> hypertext(const Node& node) {
        if (!hasLinks(node)) return {};
        HypertextSource source{*this};
        static const auto limits = core::request({{"limits", true}}, voice_core_context_json);
        try {
            return flattenHypertext(source, node, limits.at("caretSourceElements").get<size_t>(), limits.at("caretSourceBytes").get<size_t>());
        } catch (const ScreenBudgetExceeded&) { throw; }
        catch (const std::exception&) { return Hypertext{{}, 0, std::nullopt, std::nullopt, false}; }
    }
    std::optional<std::chrono::steady_clock::time_point> deadline;
    void check() const { if (!withinBudget()) throw ScreenBudgetExceeded(); }
    std::string range(const Object<AtspiText>& text, int from, int to) {
        check(); Error error;
        auto value = atspi_text_get_text(text.get(), from, to, &error.value);
        std::unique_ptr<gchar, decltype(&g_free)> owned(value, &g_free);
        error.check(); check();
        if (!completeProviderRange(value, from, to))
            throw std::runtime_error("invalid provider text");
        return value;
    }
};

// This metadata-only preflight precedes titles, values, counts and selections.
// Aggregated ranges may include descendants, so they need a password census too.
template<class Tree>
bool safeSubtree(Tree& tree, typename Tree::Node root, const ScreenExclusions& exclusions, bool prohibitPasswords) {
    const size_t budget = walk::limits().nodeBudget;
    if constexpr (requires { tree.privacyNodes(root); }) {
        if (auto nodes = tree.privacyNodes(root)) {
            if (nodes->size() > budget) return false;
            for (const auto& node : *nodes) {
                if (!tree.withinBudget()) return false;
                if (tree.isPassword(node)) { if (prohibitPasswords) return false; else continue; }
                if (const auto page = tree.page(node); page && exclusions.excludes(*page)) throw PrivacyHidden{};
            }
            return tree.withinBudget();
        }
    }
    // The element itself is not counted: as many elements inside it as the budget are seen
    // whole. Each element fetches one more child than the visits left, so a census that
    // overflows says so; only visits count, as what waits may never be visited (the shared
    // core's census, walk.rs).
    std::vector<typename Tree::Node> stack{root};
    size_t visited = 0;
    bool first = true;
    while (!stack.empty()) {
        if (!first && ++visited > budget) return false;
        if (!tree.withinBudget()) return false;
        first = false;
        auto node = std::move(stack.back()); stack.pop_back();
        if (tree.isPassword(node)) { if (prohibitPasswords) return false; else continue; }
        if (const auto page = tree.page(node); page && exclusions.excludes(*page)) throw PrivacyHidden{};
        auto children = tree.children(node, budget + 1 - visited);
        for (auto it = children.rbegin(); it != children.rend(); ++it) stack.push_back(*it);
    }
    return tree.withinBudget();
}
// Simple test trees retain their legacy fixture method; live readers use the
// shared source collector, never a native character cutoff, for screen text.
template<class Tree>
std::optional<std::string> screenText(Tree& tree, typename Tree::Node node) {
    if constexpr (requires { tree.screenText(node); }) return tree.screenText(node);
    else return tree.field(node, static_cast<int>(VisibleContext::sourceLimit()));
}
// How long a read took, for its reply's summary.
inline uint64_t elapsedMilliseconds(std::chrono::steady_clock::time_point started) {
    return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count());
}
// The shared walk's role (walk.rs) of an AT-SPI role. A page is what the tree gives a page for.
inline std::string sharedRole(AtspiRole role) {
    switch (role) {
        case ATSPI_ROLE_PARAGRAPH: case ATSPI_ROLE_STATIC: case ATSPI_ROLE_LABEL: return "text";
        case ATSPI_ROLE_TEXT: case ATSPI_ROLE_ENTRY: case ATSPI_ROLE_PASSWORD_TEXT: case ATSPI_ROLE_TERMINAL: return "field";
        case ATSPI_ROLE_HEADING: return "heading";
        case ATSPI_ROLE_LINK: return "link";
        case ATSPI_ROLE_TABLE_ROW: return "row";
        case ATSPI_ROLE_LIST_ITEM: return "listItem";
        case ATSPI_ROLE_PUSH_BUTTON: case ATSPI_ROLE_TOGGLE_BUTTON: case ATSPI_ROLE_CHECK_BOX:
        case ATSPI_ROLE_RADIO_BUTTON: case ATSPI_ROLE_COMBO_BOX: return "control";
        case ATSPI_ROLE_TOOL_BAR: return "toolbar";
        case ATSPI_ROLE_MENU_BAR: case ATSPI_ROLE_MENU: case ATSPI_ROLE_MENU_ITEM: case ATSPI_ROLE_IMAGE:
        case ATSPI_ROLE_SCROLL_BAR: case ATSPI_ROLE_SLIDER: case ATSPI_ROLE_SPIN_BUTTON: return "chrome";
        default: return "other";
    }
}
inline std::optional<walk::Frame> walkFrame(const std::optional<ContextFrame>& frame) {
    if (!frame) return {};
    return walk::Frame{frame->x, frame->y, frame->width, frame->height};
}
// What AT-SPI says about one element, for the shared walk (`walk::node`). A password element is
// asked nothing more than where it is: no page, name or text.
template<class Tree>
walk::Facts factsOf(Tree& tree, typename Tree::Node node, bool inPage, const std::optional<ContextFrame>& window,
                    const ScreenExclusions& exclusions, std::optional<PageHost>& page, std::optional<ContextFrame>& frame) {
    walk::Facts facts;
    facts.role = sharedRole(tree.role(node));
    facts.inPage = inPage;
    facts.password = tree.isPassword(node);
    if (!facts.password) page = tree.page(node);
    if (page) {
        facts.role = "page";
        facts.pageExcluded = exclusions.excludes(*page);
    }
    frame = tree.frame(node);
    facts.hidden = !tree.shown(node);
    facts.frame = walkFrame(frame);
    facts.window = walkFrame(window);
    return facts;
}
// A look inside an element read whole: the metadata census (`safeSubtree`, with the provider's
// collection where it has one), as the shared walk's look. A protected element inside, or a
// census that ran out of budget, has not shown the element safe to read whole.
template<class Tree>
walk::PageLook lookInside(Tree& tree, typename Tree::Node node, const ScreenExclusions& exclusions) {
    try { return safeSubtree(tree, node, exclusions, true) ? walk::PageLook::none : walk::PageLook::notSeenWhole; }
    catch (const PrivacyHidden&) { return walk::PageLook::excluded; }
}
// Text of a heading, link or row gathered from what is under it, as the walk reads it: its text
// and its fields, each part as the shared walk says (`part`). Throws `PrivacyHidden` when a page
// of an excluded website is among them.
template<class Tree>
nlohmann::json semanticSource(Tree& tree, typename Tree::Node root, SemanticText::Kind kind, size_t& visited,
                              const ScreenExclusions& exclusions, bool inPage = false, const std::optional<ContextFrame>& window = {}) {
    const auto& limits = walk::limits();
    // The core says when its elements run out.
    const auto stopped = [&] { return walk::stop(visited, false).has_value(); };
    SemanticText reducer(kind);
    // Its own label can be made of what it holds, so it is looked through first.
    const auto offerRoot = [&] {
        const auto outcome = walk::look("semantic", lookInside(tree, root, exclusions));
        if (outcome == "refuse") throw PrivacyHidden{};
        reducer.offer(SemanticText::Event::root, outcome == "marker" ? VisibleContext::hiddenMarker() : tree.label(root));
    };
    if (reducer.decision() == SemanticText::Decision::root) offerRoot();
    if (reducer.decision() == SemanticText::Decision::descendants) {
        if (stopped()) { reducer.offer(SemanticText::Event::interrupted); return reducer.projectedSource(); }
        std::vector<std::pair<typename Tree::Node, bool>> stack;
        const auto push = [&](typename Tree::Node node, bool childrenInPage) {
            auto children = tree.children(node, limits.nodeBudget - std::min(limits.nodeBudget, visited + stack.size()));
            for (auto it = children.rbegin(); it != children.rend(); ++it) stack.emplace_back(*it, childrenInPage);
        };
        push(root, inPage);
        while (!stack.empty() && reducer.decision() == SemanticText::Decision::descendants) {
            if (stopped()) break;
            ++visited;
            auto [node, partInPage] = std::move(stack.back()); stack.pop_back();
            std::optional<PageHost> page;
            std::optional<ContextFrame> frame;
            auto facts = factsOf(tree, node, partInPage, window, exclusions, page, frame);
            facts.part = true;
            const auto step = walk::node(facts);
            if (step.action == "refuse") throw PrivacyHidden{};
            if (step.action == "skip") {
                // One that shows nothing is looked inside first: an excluded page under it refuses the window.
                if (!step.look.empty() && walk::look(step.look, lookInside(tree, node, exclusions)) == "refuse") throw PrivacyHidden{};
                continue;
            }
            if (step.action == "field" || step.action == "text" || step.action == "caption") {
                const auto outcome = walk::look(step.action, lookInside(tree, node, exclusions));
                if (outcome == "refuse") throw PrivacyHidden{};
                if (outcome == "marker") { reducer.offer(SemanticText::Event::descendant, VisibleContext::hiddenMarker()); continue; }
                if (step.action == "field") {
                    if constexpr (requires { tree.appendFieldSource(node, window, std::declval<VisibleContext&>(), frame); }) {
                        VisibleContext field;
                        tree.appendFieldSource(node, window, field, frame);
                        const auto sources = field.fieldSources();
                        if (sources.empty()) reducer.offer(SemanticText::Event::descendant, tree.label(node));
                        for (const auto& parts : sources) {
                            if (reducer.decision() != SemanticText::Decision::descendants) break;
                            reducer.offerProjected(SemanticText::Event::descendant, parts);
                        }
                        continue;
                    }
                }
                if (step.action == "caption") {
                    // A page's control: its name, or, having none, what it holds.
                    const auto label = tree.label(node);
                    if (label.empty()) { push(node, step.childrenInPage); continue; }
                    reducer.offer(SemanticText::Event::descendant, label);
                    continue;
                }
                const auto field = screenText(tree, node);
                reducer.offer(SemanticText::Event::descendant, field ? *field : tree.label(node));
                continue;
            }
            push(node, step.childrenInPage);
        }
        if (reducer.decision() == SemanticText::Decision::descendants)
            reducer.offer(stack.empty() && !stopped() ? SemanticText::Event::complete : SemanticText::Event::interrupted);
    }
    if (reducer.decision() == SemanticText::Decision::root) offerRoot();
    return reducer.projectedSource();
}
// String convenience for simple test trees; production retains projected metadata.
template<class Tree>
std::string semanticLabel(Tree& tree, typename Tree::Node root, SemanticText::Kind kind, size_t& visited,
                          const ScreenExclusions& exclusions, const std::optional<ContextFrame>& window = {}) {
    return semanticSource(tree, root, kind, visited, exclusions, false, window).at("text").template get<std::string>();
}
template<class Tree>
nlohmann::json gatherTerminalScreen(Tree& tree, typename Tree::Node window, typename Tree::Node focus,
    const std::vector<typename Tree::Node>& path, const AppIdentity& app, const ScreenExclusions& exclusions) {
    using JSON=nlohmann::json;
    const auto started = std::chrono::steady_clock::now();
    if constexpr (!requires { tree.viewportSurface(focus, size_t{}, ContextFrame{}, true, size_t{}); }) {
        return nullptr;
    } else {
        if (!safeSubtree(tree,window,exclusions,false)) return nullptr;
        const auto windowFrame=tree.frame(window);
        if(!windowFrame || windowFrame->width<=0 || windowFrame->height<=0) return nullptr;
        // What is gathered, how much, and what the viewport says are the shared core's (`collect`).
        JSON collected=core::request({{"collect",{{"start",true}}}},voice_core_viewport_json);
        size_t visited=0;
        bool complete=true;
        using Node=typename Tree::Node;
        std::vector<std::pair<Node,ContextFrame>> stack{{window,*windowFrame}};
        std::vector<Node> seen;
        std::vector<Node> read;
        while(!stack.empty()) {
            if(visited>=walk::limits().nodeBudget) { complete=false; break; }
            auto [node,clip]=stack.back();stack.pop_back();
            if(std::any_of(seen.begin(),seen.end(),[&](const auto& prior){return tree.same(prior,node);})) continue;
            seen.push_back(node);++visited;
            if(!tree.shown(node)) continue;
            if(tree.isPassword(node)) { complete=false;continue; }
            if(auto page=tree.page(node);page && exclusions.excludes(*page)) throw PrivacyHidden{};
            const auto frame=tree.frame(node);
            if(frame) {
                const double right=std::min(clip.x+clip.width,frame->x+frame->width),bottom=std::min(clip.y+clip.height,frame->y+frame->height);
                clip.x=std::max(clip.x,frame->x);clip.y=std::max(clip.y,frame->y);clip.width=right-clip.x;clip.height=bottom-clip.y;
                if(clip.width<=0 || clip.height<=0) continue;
            }
            if(tree.role(node)==ATSPI_ROLE_TERMINAL) {
                if(!frame || !safeSubtree(tree,node,exclusions,true)) {complete=false;continue;}
                const JSON next=core::request({{"collect",{{"state",collected},{"next",true}}}},voice_core_viewport_json);
                if(!next.at("read").get<bool>()) {complete=false;break;}
                const bool ownsFocus=tree.same(node,focus) || std::any_of(path.begin(),path.end(),[&](const auto& parent){return tree.same(parent,node);});
                JSON value;
                try { value=tree.viewportSurface(node,next.at("id").get<size_t>(),clip,ownsFocus,next.at("bytes").get<size_t>()); }
                catch(const std::exception& error) {
                    // A fixed reason, never text.
                    std::cerr << "debug screen: terminal surface refused: " << error.what() << "\n";
                    complete=false;continue;
                }
                collected=core::request({{"collect",{{"state",collected},{"take",value},{"focused",ownsFocus}}}},voice_core_viewport_json);
                read.push_back(node);
                continue;
            }
            if(stack.size()>=walk::limits().nodeBudget-visited) {complete=false;break;}
            auto children=tree.children(node,walk::limits().nodeBudget-visited-stack.size());
            for(auto it=children.rbegin();it!=children.rend();++it) stack.emplace_back(*it,clip);
        }
        // Privacy is checked again at the end; the text is not read again.
        for(const auto& node:read) if(!safeSubtree(tree,node,exclusions,true)) return nullptr;
        if(!safeSubtree(tree,window,exclusions,false)) return nullptr;
        const JSON viewport=core::request({{"collect",{{"state",collected},{"finish",{{"complete",complete},{"offsetUnit","scalar"}}}}}},voice_core_viewport_json);
        const auto title=tree.label(window);
        return screenReply({{"appName",app.name},{"bundleID",app.id},{"windowTitle",title},{"host",nullptr},{"terminalProgram",nullptr},
            {"focusedRole","terminal"},{"viewport",viewport}},exclusions.lists(),visited,elapsedMilliseconds(started),"");
    }
}

template<class Tree>
nlohmann::json gatherScreenUnchecked(Tree& tree, typename Tree::Node window, typename Tree::Node focus,
    const std::vector<typename Tree::Node>& path, const AppIdentity& app, const ScreenExclusions& exclusions) {
    using JSON = nlohmann::json;
    const auto started = std::chrono::steady_clock::now();
    std::optional<std::string> host;
    bool protectedFocus = false;
    for (const auto& node : path) {
        protectedFocus |= tree.isPassword(node);
        if (auto page = tree.page(node)) { if (exclusions.excludes(*page)) throw PrivacyHidden{}; if (!host && !page->name.empty()) host = page->name; }
    }
    if (auto page = tree.page(focus)) { if (exclusions.excludes(*page)) throw PrivacyHidden{}; if (!page->name.empty()) host = page->name; }
    // Match the reference: check the focus and its pages before asking for text.
    // Other pages are checked as the bounded walk reaches them; a refusal drops
    // everything gathered. A whole-window preflight exhausts the read budget in
    // browsers before even the focused field can be collected.
    if (!safeSubtree(tree, focus, exclusions, false)) return nullptr;
    std::array<std::string, 3> around{};
    bool selectionUnavailable = false;
    const auto focusRole = tree.role(focus);
    // A terminal's cursor belongs to its running program, not an editable form.
    // Read the bounded terminal field instead, including when focus is a child.
    const bool terminalInFocus = focusRole == ATSPI_ROLE_TERMINAL ||
        std::any_of(path.begin(), path.end(), [&](const auto& parent) { return tree.role(parent) == ATSPI_ROLE_TERMINAL; });
    if (terminalInFocus) return gatherTerminalScreen(tree,window,focus,path,app,exclusions);
    const bool fieldInFocus = !terminalInFocus && (focusRole == ATSPI_ROLE_ENTRY || focusRole == ATSPI_ROLE_TEXT ||
        focusRole == ATSPI_ROLE_PASSWORD_TEXT || focusRole == ATSPI_ROLE_COMBO_BOX || tree.editable(focus));
    const bool readableFocus = !protectedFocus && safeSubtree(tree, focus, exclusions, true);
    if (readableFocus) {
        if (auto caret = tree.caret(focus)) {
            around = caret->parts;
            selectionUnavailable = caret->selectionUnavailable;
        }
    }
    if (!fieldInFocus) { around[0].clear(); around[2].clear(); }
    // The focused page checks precede the title, as on macOS.
    const auto title = tree.label(window);
    const auto windowFrame = tree.frame(window);
    VisibleContext context(around);
    const auto& limits = walk::limits();
    std::vector<std::pair<typename Tree::Node, bool>> stack{{window, false}};
    while (!stack.empty()) {
        // What to do with each element is the shared core's (`walk::node`, ADR-DESK-054).
        if (const auto stopped = walk::stop(context.nodes, context.textBudgetFull)) { context.stopped = *stopped; break; }
        auto [node, inPage] = std::move(stack.back()); stack.pop_back(); ++context.nodes;
        const bool isFocus = tree.same(node, focus);
        const bool ancestor = !isFocus && std::any_of(path.begin(), path.end(), [&](const auto& parent) { return tree.same(parent, node); });
        std::optional<PageHost> page;
        std::optional<ContextFrame> frame;
        auto facts = factsOf(tree, node, inPage, windowFrame, exclusions, page, frame);
        facts.focus = isFocus ? "self" : ancestor ? "path" : "";
        facts.focusedField = isFocus && fieldInFocus;
        facts.selection = isFocus && !around[1].empty();
        const auto step = walk::node(facts);
        if (step.action == "refuse") throw PrivacyHidden{};
        if (step.caretFirst || step.action == "caret") context.append(ContextKind::caret, "‸", frame);
        if (step.action == "skip" && !step.look.empty() && walk::look(step.look, lookInside(tree, node, exclusions)) == "refuse")
            throw PrivacyHidden{};
        if (step.action == "caret" || step.action == "skip") continue;
        if (step.host && !host && page && !page->name.empty()) host = page->name;
        // A part read in one piece is looked through first: one that holds an excluded page
        // refuses the window (a field: the marker), and one too large to look through, or
        // holding a protected element, is withheld behind the marker.
        if (step.action == "field" || step.action == "text" || step.action == "caption") {
            const auto outcome = walk::look(step.action, lookInside(tree, node, exclusions));
            if (outcome == "refuse") throw PrivacyHidden{};
            if (outcome == "marker") {
                if (step.action != "caption" || step.shown)
                    context.append(step.action == "field" ? ContextKind::field : ContextKind::text, VisibleContext::hiddenMarker(), frame);
                continue;
            }
            if (step.action == "field") {
                if constexpr (requires { tree.appendFieldSource(node, windowFrame, context, frame); })
                    tree.appendFieldSource(node, windowFrame, context, frame);
                else if (const auto value = screenText(tree, node)) context.append(ContextKind::field, *value, frame);
                continue;
            }
            if (step.action == "text") {
                const auto field = screenText(tree, node);
                context.append(ContextKind::text, field ? *field : tree.label(node), frame);
                continue;
            }
            // A page's control: its name, or, having none, what it holds.
            const auto label = tree.label(node);
            if (!label.empty()) {
                if (step.shown) context.append(ContextKind::text, label, frame);
                continue;
            }
        }
        if (step.action == "semantic") {
            const auto kind = step.kind == "heading" ? SemanticText::Kind::heading : step.kind == "link" ? SemanticText::Kind::link : SemanticText::Kind::row;
            const auto label = semanticSource(tree, node, kind, context.nodes, exclusions, inPage, windowFrame);
            context.appendSemantic(step.kind == "heading" ? ContextKind::heading : step.kind == "link" ? ContextKind::link : ContextKind::row, label, frame);
            continue;
        }
        auto children = tree.children(node, limits.nodeBudget - std::min(limits.nodeBudget, context.nodes + stack.size()));
        for (auto it = children.rbegin(); it != children.rend(); ++it) stack.emplace_back(*it, step.childrenInPage);
    }
    return context.reply({{"appName", app.name}, {"bundleID", app.id}, {"windowTitle", title},
        {"host", host ? JSON(*host) : JSON(nullptr)}, {"terminalProgram", nullptr}, {"focusedRole", std::to_string(focusRole)}},
        around, selectionUnavailable, exclusions.lists(), elapsedMilliseconds(started));
}
template<class Tree>
nlohmann::json gatherScreen(Tree& tree, typename Tree::Node window, typename Tree::Node focus,
    const std::vector<typename Tree::Node>& path, const AppIdentity& app, const ScreenExclusions& exclusions) {
    try { return gatherScreenUnchecked(tree, window, focus, path, app, exclusions); }
    catch (const PrivacyHidden&) { return hiddenScreen(); }
}
}
