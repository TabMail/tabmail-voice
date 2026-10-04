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
#include <array>
#include <cmath>
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
    static constexpr size_t nodeBudget = 5000;
    explicit LiveScreenTree(const Node& root) {
        // A browser can publish its tree after our client first sees the window.
        // Refresh cached descendants for each read, including correction learning.
        atspi_accessible_clear_cache(root.get());
    }
    bool same(const Node& first, const Node& second) { return voice::same(first, second); }
    bool withinBudget() const { return std::chrono::steady_clock::now() < deadline; }
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
            ATSPI_Collection_SORT_ORDER_CANONICAL, nodeBudget + 1, TRUE, &error.value);
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
        if (count < 0 || count > maxLength) return {};
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
                if (!value || value->start_offset < 0 || value->end_offset < value->start_offset || value->end_offset > count ||
                    (!result.empty() && result.back()[1] > value->start_offset)) throw std::runtime_error("terminal selection range");
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
        const auto spansNow = [&] {
            check(); Error error;
            auto values = atspi_text_get_bounded_ranges(text.get(), static_cast<int>(clip.x), static_cast<int>(clip.y),
                static_cast<int>(clip.width), static_cast<int>(clip.height), ATSPI_COORD_TYPE_WINDOW,
                ATSPI_TEXT_CLIP_NONE, ATSPI_TEXT_CLIP_NONE, &error.value);
            const auto release = [](GArray* array) { if (!array) return;
                for (guint i=0;i<array->len;++i) g_free(g_array_index(array,AtspiTextRange,i).content);
                g_array_unref(array); };
            std::unique_ptr<GArray,decltype(release)> owned(values,release); error.check(); check();
            if (!values || values->len > rangeLimit) throw std::runtime_error("terminal visible ranges");
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
        std::vector<std::string> captured;
        auto runs=nlohmann::json::array(), selections=nlohmann::json::array();
        nlohmann::json anchor={{"status","unavailable"}};
        size_t remaining=limit; bool selectionComplete=true;
        std::vector<int> covered; for(const auto& value:selected) covered.push_back(value[0]);
        const auto readVisible = [&](const std::array<int,2>& span, size_t budget) {
            const auto length=static_cast<size_t>(span[1]-span[0]);
            if(length > budget / 4) throw std::runtime_error("terminal source budget");
            auto value=readScalarField(length,0,length,[&](size_t from,size_t to){
                if(countNow()!=count) throw std::runtime_error("terminal count changed");
                return range(text,span[0]+static_cast<int>(from),span[0]+static_cast<int>(to));
            });
            if(!value.complete || value.text.size()>budget) throw std::runtime_error("terminal source incomplete");
            return value.text;
        };
        // VTE can encode a scrolled-away cursor as visible-text start/end.
        // Those boundary positions lack independent visible insertion proof.
        const auto caretFrameNow = [&]() -> std::optional<std::array<int,4>> {
            if(!focused || caret<=0 || caret>=count) return {};
            check(); Error error; auto rectangle=atspi_text_get_character_extents(text.get(),caret,ATSPI_COORD_TYPE_WINDOW,&error.value);
            std::unique_ptr<AtspiRect,decltype(&g_free)> owned(rectangle,&g_free);
            if(error.value || !rectangle || rectangle->width<0 || rectangle->height<=0) return {};
            return std::array<int,4>{rectangle->x,rectangle->y,rectangle->width,rectangle->height};
        };
        const auto caretFrame=caretFrameNow();
        const bool caretVisible=caretFrame && (*caretFrame)[0]>=clip.x && (*caretFrame)[0]<clip.x+clip.width &&
            static_cast<double>((*caretFrame)[1])+(*caretFrame)[3]>clip.y && (*caretFrame)[1]<clip.y+clip.height;
        if(caretFrame && !caretVisible) anchor={{"status","outsideViewport"}};
        for(size_t i=0;i<spans.size();++i) {
            const auto& span=spans[i]; const auto value=readVisible(span,remaining); remaining-=value.size(); captured.push_back(value);
            runs.push_back({{"id",i},{"text",value},{"connected",i>0 && spans[i-1][1]==span[0]},{"startKnown",false},{"endKnown",false}});
            if(caretVisible && caret>=span[0] && caret<span[1]) anchor={{"status","exact"},{"surface",id},{"run",i},{"offset",caret-span[0]}};
            for(size_t j=0;j<selected.size();++j) {
                const int from=std::max(span[0],selected[j][0]),to=std::min(span[1],selected[j][1]);
                if(from>=to) continue;
                selectionComplete=selectionComplete && covered[j]==from;covered[j]=to;
                selections.push_back({{"run",i},{"start",from-span[0]},{"end",to-span[0]}});
            }
        }
        for(size_t j=0;j<selected.size();++j) selectionComplete=selectionComplete && covered[j]==selected[j][1];
        for(size_t i=0;i<spans.size();++i) if(readVisible(spans[i],limit)!=captured[i]) throw std::runtime_error("terminal source changed");
        if(countNow()!=count || selectionsNow()!=selected || caretNow()!=caret || caretFrameNow()!=caretFrame || spansNow()!=spans || !shown(node))
            throw std::runtime_error("terminal snapshot changed");
        check();
        return {{"surface",{{"id",id},{"frame",{clip.x,clip.y,clip.width,clip.height}},{"runs",runs},
            {"selection",{{"complete",selectionComplete},{"ranges",selections}}}}},{"caret",anchor},{"offsetUnit","scalar"}};
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
        if (!initial) return CaretText::unavailable();
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
        catch (const std::exception&) { return CaretText::unavailable(); }
        const auto final = snapshot();
        check();
        if (final != initial || !state(node, ATSPI_STATE_FOCUSED)) return CaretText::unavailable();
        check();
        return result;
    }
    std::optional<CaretText> caret(const Node& node) {
        check();
        auto text = own(atspi_accessible_get_text_iface(node.get()));
        if (!text) return {};
        const auto unavailable = [] { return CaretText::unavailable(); };
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
        if (!initial) return unavailable();
        const auto [count, offset, selections, from, to] = *initial;
        // The provider owns scalar offsets and transport; Rust owns every range,
        // byte budget, selection refusal and incomplete-edge decision.
        const auto result = readScalarCaret(count, from, to, [&](size_t begin, size_t end) {
            return range(text, static_cast<int>(begin), static_cast<int>(end));
        });
        const auto final = snapshot();
        check();
        if (!final || *final != *initial || !state(node, ATSPI_STATE_FOCUSED)) return unavailable();
        check();
        return result;
    }

private:
    const std::chrono::steady_clock::time_point deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(1500);
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
    if constexpr (requires { tree.privacyNodes(root); }) {
        if (auto nodes = tree.privacyNodes(root)) {
            if (nodes->size() > 5000) return false;
            for (const auto& node : *nodes) {
                if (!tree.withinBudget()) return false;
                if (tree.isPassword(node)) { if (prohibitPasswords) return false; else continue; }
                if (const auto page = tree.page(node); page && exclusions.excludes(*page)) throw PrivacyHidden{};
            }
            return tree.withinBudget();
        }
    }
    std::vector<typename Tree::Node> stack{root};
    size_t visited = 0;
    while (!stack.empty()) {
        if (++visited > 5000 || !tree.withinBudget()) return false;
        auto node = std::move(stack.back()); stack.pop_back();
        if (tree.isPassword(node)) { if (prohibitPasswords) return false; else continue; }
        if (const auto page = tree.page(node); page && exclusions.excludes(*page)) throw PrivacyHidden{};
        auto children = tree.children(node, 5000 - visited - stack.size());
        for (auto it = children.rbegin(); it != children.rend(); ++it) stack.push_back(*it);
    }
    return tree.withinBudget();
}
inline bool skippedRole(AtspiRole role, bool web) {
    switch (role) {
        case ATSPI_ROLE_PUSH_BUTTON: case ATSPI_ROLE_TOGGLE_BUTTON: case ATSPI_ROLE_CHECK_BOX:
        case ATSPI_ROLE_RADIO_BUTTON: case ATSPI_ROLE_COMBO_BOX: case ATSPI_ROLE_TOOL_BAR: return !web;
        case ATSPI_ROLE_MENU_BAR: case ATSPI_ROLE_MENU: case ATSPI_ROLE_MENU_ITEM: case ATSPI_ROLE_IMAGE:
        case ATSPI_ROLE_SCROLL_BAR: case ATSPI_ROLE_SLIDER: case ATSPI_ROLE_SPIN_BUTTON: return true;
        default: return false;
    }
}
// Some providers put semantic row/link text in descendant text areas rather
// than the container name. Read these only after the caller's privacy census.
inline bool outsideWindow(const std::optional<ContextFrame>& frame, const std::optional<ContextFrame>& window) {
    return window && frame && frame->width > 0 && frame->height > 0 &&
        (frame->x + frame->width <= window->x || frame->y + frame->height <= window->y ||
         frame->x >= window->x + window->width || frame->y >= window->y + window->height);
}
// Simple test trees retain their legacy fixture method; live readers use the
// shared source collector, never a native character cutoff, for screen text.
template<class Tree>
std::optional<std::string> screenText(Tree& tree, typename Tree::Node node) {
    if constexpr (requires { tree.screenText(node); }) return tree.screenText(node);
    else return tree.field(node, static_cast<int>(VisibleContext::sourceLimit()));
}
template<class Tree>
nlohmann::json semanticSource(Tree& tree, typename Tree::Node root, SemanticText::Kind kind, size_t& visited,
                          const std::optional<ContextFrame>& window = {}) {
    SemanticText reducer(kind);
    if (reducer.decision() == SemanticText::Decision::root) reducer.offer(SemanticText::Event::root, tree.label(root));
    if (reducer.decision() == SemanticText::Decision::descendants) {
        if (visited >= 5000 || !tree.withinBudget()) { reducer.offer(SemanticText::Event::interrupted); return reducer.projectedSource(); }
        auto initial = tree.children(root, 5000 - std::min<size_t>(visited, 5000));
        std::vector<typename Tree::Node> stack(initial.rbegin(), initial.rend());
        while (!stack.empty() && reducer.decision() == SemanticText::Decision::descendants) {
            if (visited >= 5000 || !tree.withinBudget()) break;
            ++visited;
            auto node = std::move(stack.back()); stack.pop_back();
            if (tree.isPassword(node)) continue;
            const auto frame = tree.frame(node);
            if (!tree.shown(node) || (frame && (frame->width <= 1 || frame->height <= 1)) || outsideWindow(frame, window)) continue;
            const auto role = tree.role(node);
            if (role == ATSPI_ROLE_TEXT || role == ATSPI_ROLE_ENTRY || role == ATSPI_ROLE_STATIC ||
                role == ATSPI_ROLE_PARAGRAPH || role == ATSPI_ROLE_LABEL) {
                if constexpr (requires { tree.appendFieldSource(node, window, std::declval<VisibleContext&>(), frame); }) {
                    if (role == ATSPI_ROLE_TEXT || role == ATSPI_ROLE_ENTRY) {
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
                const auto field = screenText(tree, node);
                reducer.offer(SemanticText::Event::descendant, field ? *field : tree.label(node));
                continue;
            }
            auto children = tree.children(node, 5000 - visited - stack.size());
            for (auto it = children.rbegin(); it != children.rend(); ++it) stack.push_back(*it);
        }
        if (reducer.decision() == SemanticText::Decision::descendants)
            reducer.offer(stack.empty() && visited < 5000 && tree.withinBudget() ? SemanticText::Event::complete : SemanticText::Event::interrupted);
    }
    if (reducer.decision() == SemanticText::Decision::root) reducer.offer(SemanticText::Event::root, tree.label(root));
    return reducer.projectedSource();
}
// String convenience for simple test trees; production retains projected metadata.
template<class Tree>
std::string semanticLabel(Tree& tree, typename Tree::Node root, SemanticText::Kind kind, size_t& visited,
                          const std::optional<ContextFrame>& window = {}) {
    return semanticSource(tree, root, kind, visited, window).at("text").template get<std::string>();
}
template<class Tree>
nlohmann::json gatherTerminalScreen(Tree& tree, typename Tree::Node window, typename Tree::Node focus,
    const std::vector<typename Tree::Node>& path, const AppIdentity& app, const ScreenExclusions& exclusions) {
    using JSON=nlohmann::json;
    if constexpr (!requires { tree.viewportSurface(focus, size_t{}, ContextFrame{}, true, size_t{}); }) {
        return nullptr;
    } else {
        if (!safeSubtree(tree,window,exclusions,false)) return nullptr;
        const auto windowFrame=tree.frame(window);
        if(!windowFrame || windowFrame->width<=0 || windowFrame->height<=0) return nullptr;
        const auto limits=core::request({{"limits",true}},voice_core_viewport_json);
        size_t remaining=limits.at("bytes").get<size_t>(),visited=0;
        const size_t maxSurfaces=limits.at("surfaces").get<size_t>();
        JSON surfaces=JSON::array(),focusedID=nullptr,caret={{"status","unavailable"}};
        bool complete=true;
        using Node=typename Tree::Node;
        std::vector<std::pair<Node,ContextFrame>> stack{{window,*windowFrame}};
        std::vector<Node> seen;
        std::vector<std::pair<Node,ContextFrame>> geometry;
        const auto stableGeometry=[&] {
            return std::all_of(geometry.begin(),geometry.end(),[&](const auto& entry){
                const auto now=tree.frame(entry.first);const auto& old=entry.second;
                return now && now->x==old.x && now->y==old.y && now->width==old.width && now->height==old.height;
            });
        };
        struct Snapshot { Node node; ContextFrame clip; size_t id; bool focused; JSON value; };
        std::vector<Snapshot> snapshots;
        while(!stack.empty()) {
            if(!tree.withinBudget() || visited>=5000) { complete=false; break; }
            auto [node,clip]=stack.back();stack.pop_back();
            if(std::any_of(seen.begin(),seen.end(),[&](const auto& prior){return tree.same(prior,node);})) continue;
            seen.push_back(node);++visited;
            if(!tree.shown(node)) continue;
            if(tree.isPassword(node)) { complete=false;continue; }
            if(auto page=tree.page(node);page && exclusions.excludes(*page)) throw PrivacyHidden{};
            const auto frame=tree.frame(node);
            if(frame) {
                geometry.emplace_back(node,*frame);
                const double right=std::min(clip.x+clip.width,frame->x+frame->width),bottom=std::min(clip.y+clip.height,frame->y+frame->height);
                clip.x=std::max(clip.x,frame->x);clip.y=std::max(clip.y,frame->y);clip.width=right-clip.x;clip.height=bottom-clip.y;
                if(clip.width<=0 || clip.height<=0) continue;
            }
            if(tree.role(node)==ATSPI_ROLE_TERMINAL) {
                if(!frame || !safeSubtree(tree,node,exclusions,true)) {complete=false;continue;}
                if(surfaces.size()>=maxSurfaces || remaining==0) {complete=false;break;}
                const bool ownsFocus=tree.same(node,focus) || std::any_of(path.begin(),path.end(),[&](const auto& parent){return tree.same(parent,node);});
                const size_t id=surfaces.size();
                if(!stableGeometry()) return nullptr;
                JSON value;
                try { value=tree.viewportSurface(node,id,clip,ownsFocus,remaining); }
                catch(const ScreenBudgetExceeded&) {complete=false;break;}
                catch(const std::exception&) {complete=false;continue;}
                const auto& surface=value.at("surface");
                for(const auto& run:surface.at("runs")) {
                    const auto bytes=run.at("text").template get_ref<const std::string&>().size();
                    if(bytes>remaining) throw std::runtime_error("terminal aggregate budget");
                    remaining-=bytes;
                }
                surfaces.push_back(surface);snapshots.push_back({node,clip,id,ownsFocus,value});
                if(ownsFocus) {focusedID=id;caret=value.at("caret");}
                continue;
            }
            if(stack.size()>=5000-visited) {complete=false;break;}
            auto children=tree.children(node,5000-visited-stack.size());
            for(auto it=children.rbegin();it!=children.rend();++it) stack.emplace_back(*it,clip);
        }
        // Revalidate the entire admitted set, not just each surface in isolation.
        for(const auto& snapshot:snapshots) {
            if(!tree.withinBudget() || !stableGeometry() || !tree.shown(snapshot.node) || !safeSubtree(tree,snapshot.node,exclusions,true)) return nullptr;
            try {
                if(tree.viewportSurface(snapshot.node,snapshot.id,snapshot.clip,snapshot.focused,limits.at("bytes").get<size_t>())!=snapshot.value) return nullptr;
            } catch(const std::exception&) {return nullptr;}
        }
        const auto finalFrame=tree.frame(window);
        if(!tree.withinBudget() || !stableGeometry() || !finalFrame || finalFrame->x!=windowFrame->x || finalFrame->y!=windowFrame->y ||
            finalFrame->width!=windowFrame->width || finalFrame->height!=windowFrame->height || !safeSubtree(tree,window,exclusions,false)) return nullptr;
        const auto projected=core::request({{"surfaces",surfaces},{"focusedSurface",focusedID},{"caret",caret},{"offsetUnit","scalar"},
            {"complete",complete && !surfaces.empty()}},voice_core_viewport_json);
        const auto title=privacy::ScreenPrivacy::redact(tree.label(window));
        if(!tree.withinBudget()) return nullptr;
        const auto rendered=projected.at("renderedText").template get<std::string>();
        return {{"appName",app.name},{"bundleID",app.id},{"windowTitle",title},{"host",nullptr},{"terminalProgram",nullptr},{"focusedRole","terminal"},
            {"textBeforeCaret",""},{"textAfterCaret",""},{"selectedText",projected.at("selectedText")},
            {"selectionRedacted",!projected.at("selectionComplete").template get<bool>()},{"terminalViewport",projected},
            {"renderedText",rendered},{"summary","terminal surfaces="+std::to_string(surfaces.size())+" nodes="+std::to_string(visited)}, {"logDescription",rendered}};
    }
}

template<class Tree>
nlohmann::json gatherScreenUnchecked(Tree& tree, typename Tree::Node window, typename Tree::Node focus,
    const std::vector<typename Tree::Node>& path, const AppIdentity& app, const ScreenExclusions& exclusions) {
    using JSON = nlohmann::json;
    if (!tree.withinBudget()) return nullptr;
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
    const auto title = privacy::ScreenPrivacy::redact(tree.label(window));
    const auto windowFrame = tree.frame(window);
    VisibleContext context(around);
    std::vector<std::pair<typename Tree::Node, bool>> stack{{window, false}};
    while (!stack.empty()) {
        if (context.textBudgetFull) { context.stopped = "text budget"; break; }
        if (context.nodes >= 5000 || !tree.withinBudget()) { context.stopped = "lookup budget"; break; }
        try {
            auto [node, web] = std::move(stack.back()); stack.pop_back(); ++context.nodes;
            const auto role = tree.role(node);
            if (tree.isPassword(node) && !tree.same(node, focus)) continue;
            if (auto page = tree.page(node)) { if (exclusions.excludes(*page)) throw PrivacyHidden{}; web = true; if (!host && !page->name.empty()) host = page->name; }
            const auto frame = tree.frame(node);
            const bool shown = tree.shown(node) && (!frame || (frame->width > 1 && frame->height > 1));
            if (tree.same(node, focus)) {
                if (fieldInFocus) {
                    context.append(ContextKind::caret, "‸", frame);
                    continue;
                }
                if (!around[1].empty() && !terminalInFocus) context.append(ContextKind::caret, "‸", frame);
            }
            const bool ancestor = !tree.same(node, focus) && std::any_of(path.begin(), path.end(), [&](const auto& parent) { return tree.same(parent, node); });
            if (!ancestor && outsideWindow(frame, windowFrame)) continue;
            if (!ancestor && skippedRole(role, web)) continue;
            // A non-focused field is atomic, so a refused descendant replaces
            // that field only. A refused page reached elsewhere hides the window.
            if (role == ATSPI_ROLE_TERMINAL || (!ancestor && (role == ATSPI_ROLE_TEXT || role == ATSPI_ROLE_ENTRY))) {
                if (shown) {
                    bool safe = false;
                    try { safe = safeSubtree(tree, node, exclusions, true); }
                    catch (const PrivacyHidden&) { /* The field carries the privacy marker. */ }
                    if (!safe) context.append(ContextKind::field, "[hidden for privacy]", frame);
                    else {
                        if constexpr (requires { tree.appendFieldSource(node, windowFrame, context, frame); })
                            tree.appendFieldSource(node, windowFrame, context, frame);
                        else if (const auto value = screenText(tree, node)) context.append(ContextKind::field, *value, frame);
                    }
                }
                continue;
            }
            const bool webControl = web && (role == ATSPI_ROLE_PUSH_BUTTON || role == ATSPI_ROLE_TOGGLE_BUTTON ||
                role == ATSPI_ROLE_CHECK_BOX || role == ATSPI_ROLE_RADIO_BUTTON || role == ATSPI_ROLE_COMBO_BOX);
            const bool textRole = role == ATSPI_ROLE_TEXT || role == ATSPI_ROLE_ENTRY || role == ATSPI_ROLE_PARAGRAPH || role == ATSPI_ROLE_STATIC || role == ATSPI_ROLE_LABEL ||
                role == ATSPI_ROLE_HEADING || role == ATSPI_ROLE_LINK || role == ATSPI_ROLE_TABLE_ROW || webControl;
            if (!ancestor && shown && textRole) {
                if (!safeSubtree(tree, node, exclusions, true)) {
                    context.append(ContextKind::text, "[hidden for privacy]", frame);
                    continue;
                }
                if (role == ATSPI_ROLE_TEXT || role == ATSPI_ROLE_ENTRY || role == ATSPI_ROLE_PARAGRAPH || role == ATSPI_ROLE_STATIC || role == ATSPI_ROLE_LABEL) {
                    const auto field = screenText(tree, node);
                    const auto label = field ? *field : tree.label(node);
                    context.append(role == ATSPI_ROLE_ENTRY || role == ATSPI_ROLE_TEXT ? ContextKind::field : ContextKind::text, label, frame);
                    continue;
                }
                if (role == ATSPI_ROLE_HEADING || role == ATSPI_ROLE_LINK || role == ATSPI_ROLE_TABLE_ROW) {
                    const auto kind = role == ATSPI_ROLE_HEADING ? SemanticText::Kind::heading : role == ATSPI_ROLE_LINK ? SemanticText::Kind::link : SemanticText::Kind::row;
                    const auto label = semanticSource(tree, node, kind, context.nodes, windowFrame);
                    context.appendSemantic(role == ATSPI_ROLE_HEADING ? ContextKind::heading : role == ATSPI_ROLE_LINK ? ContextKind::link : ContextKind::row, label, frame);
                    continue;
                }
                if (webControl) {
                    const auto label = tree.label(node);
                    if (!label.empty()) { context.append(ContextKind::text, label, frame); continue; }
                }
            }
            auto children = tree.children(node, 5000 - context.nodes - stack.size());
            for (auto it = children.rbegin(); it != children.rend(); ++it) stack.emplace_back(*it, web);
        } catch (const ScreenBudgetExceeded&) { context.stopped = "lookup budget"; break; }
    }
    const bool redactionChangedSelection = privacy::ScreenPrivacy::apply(context, around);
    const bool selectionRedacted = selectionUnavailable || redactionChangedSelection;
    const auto rendered = context.render();
    const auto summary = "nodes=" + std::to_string(context.nodes) + " blocks=" + std::to_string(context.count()) +
        " bytes=" + std::to_string(rendered.size()) + (context.stopped.empty() ? "" : " stopped=" + context.stopped);
    return JSON{{"appName", app.name}, {"bundleID", app.id}, {"windowTitle", title},
        {"host", host ? JSON(*host) : JSON(nullptr)}, {"terminalProgram", nullptr}, {"focusedRole", std::to_string(focusRole)},
        {"textBeforeCaret", around[0]}, {"selectedText", around[1]}, {"textAfterCaret", around[2]},
        {"selectionRedacted", selectionRedacted}, {"renderedText", rendered}, {"summary", summary}, {"logDescription", rendered}};
}
template<class Tree>
nlohmann::json gatherScreen(Tree& tree, typename Tree::Node window, typename Tree::Node focus,
    const std::vector<typename Tree::Node>& path, const AppIdentity& app, const ScreenExclusions& exclusions) {
    try { return gatherScreenUnchecked(tree, window, focus, path, app, exclusions); }
    catch (const PrivacyHidden&) { return hiddenScreen(); }
    catch (const ScreenBudgetExceeded&) { return nullptr; }
}
}
