// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#include "accessible_text.h"
#include <functional>
#include <iostream>
#include <map>

using namespace voice;
static void expect(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
static bool throws(const auto& call) { try { call(); } catch (const std::runtime_error&) { return true; } return false; }

// A rich editor's element as Firefox's and Chromium's IAccessible2 give it: one COM object that is
// its text, its hypertext, the hyperlink its parent's text holds it by, and an IAccessible2 element.
// One with no text (an image) answers for no text interface. Offsets count UTF-16 units.
struct Element final : IAccessibleHypertext, IAccessibleHyperlink, IAccessible2 {
    std::wstring text;
    long caret = -1;
    std::optional<std::pair<long, long>> selection;
    // Selections past the first: a multi-range selection.
    std::vector<std::pair<long, long>> moreSelections;
    std::vector<std::pair<long, Element*>> links;
    std::wstring attributes = L"display:block;";
    long roleId = ROLE_SYSTEM_GROUPING;
    bool hasText = true;
    long start = 0;  // where its parent's text holds it
    unsigned textReads = 0;
    // Run when its text is read: an editor that changes while the read goes on.
    std::function<void()> onTextRead;
    explicit Element(std::wstring value = L"") : text(std::move(value)) {}

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** result) override {
        *result = nullptr;
        if (iid == __uuidof(IUnknown)) *result = static_cast<IAccessible2*>(this);
        else if (hasText && iid == __uuidof(IAccessibleText)) *result = static_cast<IAccessibleText*>(static_cast<IAccessibleHypertext*>(this));
        else if (hasText && iid == __uuidof(IAccessibleHypertext)) *result = static_cast<IAccessibleHypertext*>(this);
        else if (iid == __uuidof(IAccessibleHyperlink)) *result = static_cast<IAccessibleHyperlink*>(this);
        else if (iid == __uuidof(IAccessibleAction)) *result = static_cast<IAccessibleAction*>(this);
        else if (iid == __uuidof(IAccessible2)) *result = static_cast<IAccessible2*>(this);
        else if (iid == __uuidof(IAccessible)) *result = static_cast<IAccessible*>(this);
        else if (iid == __uuidof(IDispatch)) *result = static_cast<IDispatch*>(this);
        return *result ? S_OK : E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return 2; }
    ULONG STDMETHODCALLTYPE Release() override { return 1; }

    // IAccessibleText
    HRESULT STDMETHODCALLTYPE get_nCharacters(long* count) override { *count = static_cast<long>(text.size()); return S_OK; }
    HRESULT STDMETHODCALLTYPE get_nSelections(long* count) override { *count = (selection ? 1 : 0) + static_cast<long>(moreSelections.size()); return S_OK; }
    HRESULT STDMETHODCALLTYPE get_caretOffset(long* offset) override { *offset = caret; return caret < 0 ? S_FALSE : S_OK; }
    HRESULT STDMETHODCALLTYPE get_selection(long index, long* from, long* to) override {
        if (!selection || index < 0 || static_cast<size_t>(index) > moreSelections.size()) return E_INVALIDARG;
        const auto& range = index == 0 ? *selection : moreSelections[static_cast<size_t>(index) - 1];
        *from = range.first; *to = range.second; return S_OK;
    }
    HRESULT STDMETHODCALLTYPE get_text(long from, long to, BSTR* result) override {
        ++textReads;
        if (onTextRead) onTextRead();
        if (from < 0 || to < from || to > static_cast<long>(text.size())) return E_INVALIDARG;
        *result = SysAllocStringLen(text.data() + from, static_cast<UINT>(to - from));
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE addSelection(long, long) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_attributes(long, long*, long*, BSTR*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_characterExtents(long, enum IA2CoordinateType, long*, long*, long*, long*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_offsetAtPoint(long, long, enum IA2CoordinateType, long*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_textBeforeOffset(long, enum IA2TextBoundaryType, long*, long*, BSTR*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_textAfterOffset(long, enum IA2TextBoundaryType, long*, long*, BSTR*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_textAtOffset(long, enum IA2TextBoundaryType, long*, long*, BSTR*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE removeSelection(long) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE setCaretOffset(long) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE setSelection(long, long, long) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE scrollSubstringTo(long, long, enum IA2ScrollType) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE scrollSubstringToPoint(long, long, enum IA2CoordinateType, long, long) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_newText(IA2TextSegment*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_oldText(IA2TextSegment*) override { return E_NOTIMPL; }
    // IAccessibleHypertext
    HRESULT STDMETHODCALLTYPE get_nHyperlinks(long* count) override { *count = static_cast<long>(links.size()); return S_OK; }
    HRESULT STDMETHODCALLTYPE get_hyperlink(long index, IAccessibleHyperlink** link) override {
        if (index < 0 || index >= static_cast<long>(links.size())) return E_INVALIDARG;
        links[static_cast<size_t>(index)].second->start = links[static_cast<size_t>(index)].first;
        *link = static_cast<IAccessibleHyperlink*>(links[static_cast<size_t>(index)].second);
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE get_hyperlinkIndex(long, long*) override { return E_NOTIMPL; }
    // IAccessibleHyperlink and IAccessibleAction
    HRESULT STDMETHODCALLTYPE get_anchor(long, VARIANT*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_anchorTarget(long, VARIANT*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_startIndex(long* index) override { *index = start; return S_OK; }
    HRESULT STDMETHODCALLTYPE get_endIndex(long* index) override { *index = start + 1; return S_OK; }
    HRESULT STDMETHODCALLTYPE get_valid(boolean*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE nActions(long*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE doAction(long) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_description(long, BSTR*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_keyBinding(long, long, BSTR**, long*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_name(long, BSTR*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_localizedName(long, BSTR*) override { return E_NOTIMPL; }
    // IAccessible2
    HRESULT STDMETHODCALLTYPE get_nRelations(long*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_relation(long, IAccessibleRelation**) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_relations(long, IAccessibleRelation**, long*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE role(long* value) override { *value = roleId; return S_OK; }
    HRESULT STDMETHODCALLTYPE scrollTo(enum IA2ScrollType) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE scrollToPoint(enum IA2CoordinateType, long, long) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_groupPosition(long*, long*, long*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_states(AccessibleStates*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_extendedRole(BSTR*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_localizedExtendedRole(BSTR*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_nExtendedStates(long*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_extendedStates(long, BSTR**, long*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_localizedExtendedStates(long, BSTR**, long*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_uniqueID(long*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_windowHandle(HWND*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_indexInParent(long*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_locale(IA2Locale*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_attributes(BSTR* value) override { *value = SysAllocStringLen(attributes.data(), static_cast<UINT>(attributes.size())); return S_OK; }
    // IAccessible and IDispatch
    HRESULT STDMETHODCALLTYPE GetTypeInfoCount(UINT*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE GetTypeInfo(UINT, LCID, ITypeInfo**) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE GetIDsOfNames(REFIID, LPOLESTR*, UINT, LCID, DISPID*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE Invoke(DISPID, REFIID, LCID, WORD, DISPPARAMS*, VARIANT*, EXCEPINFO*, UINT*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_accParent(IDispatch**) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_accChildCount(long*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_accChild(VARIANT, IDispatch**) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_accName(VARIANT, BSTR*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_accValue(VARIANT, BSTR*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_accDescription(VARIANT, BSTR*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_accRole(VARIANT, VARIANT*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_accState(VARIANT, VARIANT*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_accHelp(VARIANT, BSTR*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_accHelpTopic(BSTR*, VARIANT, long*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_accKeyboardShortcut(VARIANT, BSTR*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_accFocus(VARIANT*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_accSelection(VARIANT*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_accDefaultAction(VARIANT, BSTR*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE accSelect(long, VARIANT) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE accLocation(long*, long*, long*, long*, VARIANT) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE accNavigate(long, VARIANT, VARIANT*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE accHitTest(long, long, VARIANT*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE accDoDefaultAction(VARIANT) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE put_accName(VARIANT, BSTR) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE put_accValue(VARIANT, BSTR) override { return E_NOTIMPL; }
};

static const std::wstring objectChar(1, wchar_t{0xFFFC});
static Hypertext flatten(Element& root, size_t bytes = 1000, size_t attributeUnits = 1000) {
    AccessibleHypertextSource source(attributeUnits);
    return flattenHypertext(source, AccessibleHypertextSource::nodeOf(static_cast<IAccessible2*>(&root)), bytes, 64);
}
static std::string before(const Hypertext& flat) { return scalarSlice(flat.text, 0, *flat.caret); }
static IAccessibleText* textOf(Element& element) { return static_cast<IAccessibleText*>(static_cast<IAccessibleHypertext*>(&element)); }
static std::optional<std::wstring> richValue(Element& field, bool stillValid = true, unsigned limit = 1000) {
    return AccessibleText::richValue(textOf(field), limit, [&] { return stillValid; });
}
static CaretSource richCaret(Element& field, bool stillValid = true) {
    return AccessibleText::richCaret(textOf(field), [&] { return stillValid; });
}
static bool unreadCaret(const CaretSource& caret) { return caret.parts == std::array<std::string, 3>{"", "", ""}; }
// A caret window withheld with text selected: the core's refusal, the redaction marker as its selection.
static bool withheldSelection(const CaretSource& caret) { return caret.parts == CaretSource::unread(true).parts && caret.selectionUnavailable; }

// The field's value and caret read through its elements, as the field and screen readers read them:
// whole or not at all.
static void richReads() {
    Element one(L"Line one"), two(L"Line two");
    one.caret = 4;
    Element field(objectChar + objectChar);
    field.links = {{0, &one}, {1, &two}};
    expect(richValue(field) == std::wstring(L"Line one\nLine two"), "a rich field's value is its elements' text, joined");
    auto caret = richCaret(field);
    expect(caret.parts[0] == "Line" && caret.parts[1].empty() && caret.parts[2] == " one\nLine two", "a rich field's caret is placed in its line");

    // A line already read that changes, text and caret, while a later one is read: the field's
    // own size, caret and selection stay as they were, and neither its value nor its caret is read.
    two.onTextRead = [&] { one.text = L"Line one!!"; one.caret = 6; };
    expect(!richValue(field), "a rich value whose read line changed during the read is not read");
    one.text = L"Line one"; one.caret = 4;
    caret = richCaret(field);
    expect(unreadCaret(caret) && !caret.selectionUnavailable, "a rich caret whose read line changed during the read is not read");
    two.onTextRead = nullptr; one.text = L"Line one"; one.caret = 4;
    // A line already read whose caret alone moves while a later one is read, its text the same.
    two.onTextRead = [&] { one.caret = 6; };
    expect(!richValue(field), "a rich value whose read line's caret moved during the read is not read");
    one.caret = 4;
    caret = richCaret(field);
    expect(unreadCaret(caret) && !caret.selectionUnavailable, "a rich caret whose read line's caret moved during the read is not read");
    two.onTextRead = nullptr; one.caret = 4;

    // A field no longer the focused one, read or not: neither is kept.
    expect(!richValue(field, false), "a rich value of a field no longer focused is not kept");
    expect(unreadCaret(richCaret(field, false)), "a rich caret of a field no longer focused is not kept");

    // A value longer than the read asks for is not read; one exactly that long is.
    const auto whole = std::wstring(L"Line one\nLine two");
    expect(richValue(field, true, static_cast<unsigned>(whole.size())) == whole, "a rich value as long as the limit is read");
    expect(!richValue(field, true, static_cast<unsigned>(whole.size() - 1)), "a rich value past the limit is not read");

    // Text selected in the field: a caret window that can't be read is a withheld selection, never
    // a caret with nothing selected (which agent mode would take as nothing to edit).
    field.selection = std::pair{0L, 2L};
    one.selection = std::pair{0L, 8L};
    two.selection = std::pair{0L, 8L};
    caret = richCaret(field);
    expect(caret.parts[1] == "Line one\nLine two" && !caret.selectionUnavailable, "a rich selection over two lines is read");
    // Two ranges selected: not read, the selection withheld.
    field.moreSelections = {{1L, 2L}};
    caret = richCaret(field);
    expect(withheldSelection(caret), "a rich field with more than one selection withholds it");
    field.moreSelections.clear();
    // A line that changes while a later one is read, with text selected.
    two.onTextRead = [&] { one.text = L"Line one!!"; };
    caret = richCaret(field);
    expect(withheldSelection(caret), "a rich selection whose read line changed is withheld");
    two.onTextRead = nullptr; one.text = L"Line one";
    // A line already read whose part of the selection alone changes while a later one is read.
    two.onTextRead = [&] { one.selection = std::pair{2L, 8L}; };
    expect(!richValue(field), "a rich value whose read line's selection changed during the read is not read");
    one.selection = std::pair{0L, 8L};
    caret = richCaret(field);
    expect(withheldSelection(caret), "a rich selection whose read line's selection changed is withheld");
    two.onTextRead = nullptr; one.selection = std::pair{0L, 8L};
    // The field no longer focused, with text selected.
    caret = richCaret(field, false);
    expect(withheldSelection(caret), "a rich selection of a field no longer focused is withheld");
    // The field selects text, and its elements' parts give an empty selection (the field selects an
    // inline element whose own part is empty, so the selection is at its end with no break): not
    // read as a caret.
    field.selection = std::pair{0L, 1L};
    one.attributes = L"display:inline;";
    one.selection = std::pair{4L, 4L};
    two.selection.reset();
    caret = richCaret(field);
    expect(withheldSelection(caret), "a rich selection the elements leave empty is withheld");
    field.selection.reset(); one.selection.reset(); two.selection.reset();
    one.attributes = L"display:block;";

    // A field holding only an image reads as empty, not as an error.
    Element image;
    image.hasText = false;
    image.attributes = L"display:inline;";
    image.roleId = ROLE_SYSTEM_GRAPHIC;
    Element pictured(objectChar);
    pictured.links = {{0, &image}};
    expect(richValue(pictured) == std::wstring(), "a rich field holding only an image reads as empty");

    // A field whose own caret is -1, its caret in one of its lines (Firefox's): placed by its line.
    one.caret = -1; two.caret = 2;
    caret = richCaret(field);
    expect(caret.parts[0] == "Line one\nLi" && caret.parts[2] == "ne two", "a rich caret in none of the field's own text is placed by its line");
    two.caret = -1; one.caret = 4;

    // A screen read the app asks to stop gives the field up unread.
    walk::readStops().reading = 37;
    walk::readStops().ask(37);
    const auto stoppedValue = richValue(field);
    const auto stoppedCaret = richCaret(field);
    walk::readStops().reading = 0;
    expect(!stoppedValue && unreadCaret(stoppedCaret), "a stopped screen read reads no rich field");
    expect(richValue(field) == std::wstring(L"Line one\nLine two"), "a read with no number is never stopped");

    // An element's attributes past the read's bytes are not looked through: nothing is read.
    const auto bytes = core::request({{"limits", true}}, voice_core_context_json).at("caretSourceBytes").get<size_t>();
    two.attributes = std::wstring(bytes, L'x') + L":y;display:block;";
    expect(!richValue(field) && unreadCaret(richCaret(field)), "attributes past the read's bytes read no rich field");
    two.attributes = L"display:block;";
}

int main() {
    try {
        // A code editor's lines in Firefox (Overleaf-like): each line an element in the field's text
        // as U+FFFC, an empty line one holding its `<br>`'s "\n", the caret in the empty line's own
        // text and in none of the field's (Firefox gives the field -1). The field reads with its
        // line breaks, the caret at the empty line's start.
        Element one(L"Line one"), empty(L"\n"), three(L"Line three");
        empty.caret = 0;
        Element field(objectChar + objectChar + objectChar);
        field.links = {{0, &one}, {1, &empty}, {2, &three}};
        auto flat = flatten(field);
        expect(flat.complete && flat.text == "Line one\n\nLine three", "a code editor's lines are read with their breaks");
        expect(flat.caret && before(flat) == "Line one\n", "a caret on an empty line, in none of the field's own text, is placed by its line");
        // The same with the caret mid-line: the breaks around it are kept.
        empty.caret = -1; three.caret = 4;
        flat = flatten(field);
        expect(flat.caret && before(flat) == "Line one\n\nLine", "a caret mid-line is placed by its line");
        three.caret = -1;

        // UTF-16 offsets counted over in Unicode scalars: a link after an astral character, and the
        // caret at the end of the field's text.
        Element link(L"cs");
        link.attributes = L"display:inline;tag:a;";
        link.roleId = ROLE_SYSTEM_LINK;
        const std::wstring astral = L"See d\U0001F600";
        Element sentence(astral + objectChar + L" now");
        sentence.links = {{static_cast<long>(astral.size()), &link}};
        sentence.caret = static_cast<long>(sentence.text.size());
        flat = flatten(sentence);
        expect(flat.complete && flat.text == "See d\xF0\x9F\x98\x80" "cs now" && flat.length == 12, "a link joins its line; offsets count Unicode scalars");
        expect(flat.caret && *flat.caret == 12, "a caret's UTF-16 offset is counted in scalars");

        // A selection in an element's own text, in UTF-16 units past an astral character.
        Element selected(L"\U0001F600 chosen words");
        selected.selection = std::pair{3L, 9L};
        Element holder(objectChar);
        holder.links = {{0, &selected}};
        flat = flatten(holder);
        expect(flat.selection && scalarSlice(flat.text, flat.selection->first, flat.selection->second) == "chosen", "a selection's UTF-16 offsets are counted in scalars");

        // An image (no text of its own) reads as empty, and the rest is read.
        Element image;
        image.hasText = false;
        image.attributes = L"display:inline;";
        image.roleId = ROLE_SYSTEM_GRAPHIC;
        Element pictured(L"a" + objectChar + L"b");
        pictured.links = {{1, &image}};
        flat = flatten(pictured);
        expect(flat.complete && flat.text == "ab", "an element with no text reads as empty");

        // An image whose element gives no `display` joins its line by its role.
        Element bareImage;
        bareImage.hasText = false;
        bareImage.attributes = L"";
        bareImage.roleId = ROLE_SYSTEM_GRAPHIC;
        Element barePictured(L"a" + objectChar + L"b");
        barePictured.links = {{1, &bareImage}};
        flat = flatten(barePictured);
        expect(flat.complete && flat.text == "ab", "an image with no display attribute joins its line");

        // Which elements are blocks: by `display`, else by role.
        Element inlineBlock(L"x"), noDisplayLink(L"y"), noDisplayGroup(L"z");
        inlineBlock.attributes = L"display:inline-block;";
        noDisplayLink.attributes = L"tag:a;"; noDisplayLink.roleId = ROLE_SYSTEM_LINK;
        noDisplayGroup.attributes = L"";
        Element mixed(L"a" + objectChar + objectChar + objectChar);
        mixed.links = {{1, &inlineBlock}, {2, &noDisplayLink}, {3, &noDisplayGroup}};
        flat = flatten(mixed);
        expect(flat.complete && flat.text == "axy\nz", "an inline display or a link joins its line; another element starts its own");

        // An element linking back to one the read is in is not followed: one COM object is one element.
        Element loop(objectChar);
        loop.links = {{0, &loop}};
        flat = flatten(loop);
        expect(flat.complete && loop.textReads == 1, "a link back to an element being read is not followed");

        // More text than the bytes left is not read at all, before its text is asked for.
        Element big(std::wstring(20, L'a'));
        Element bigHolder(objectChar);
        bigHolder.links = {{0, &big}};
        flat = flatten(bigHolder, 10);
        expect(!flat.complete && big.textReads == 0, "an element holding more than the bytes left is not read");

        // Attributes count against the read's bytes, the elements' together.
        Element first(L"a"), second(L"b");
        Element pair2(objectChar + objectChar);
        pair2.links = {{0, &first}, {1, &second}};
        const size_t together = first.attributes.size() + pair2.attributes.size() + second.attributes.size();
        flat = flatten(pair2, 1000, together);
        expect(flat.complete && flat.text == "a\nb", "attributes within the read's bytes are read");
        expect(throws([&] { flatten(pair2, 1000, together - 1); }), "attributes past the read's bytes, together, are refused");

        // Attributes: `\` escapes, and a missing name.
        expect(AccessibleHypertextSource::attribute(L"tag:a\\;b;display:block;", L"display") == std::wstring(L"block"), "an escaped `;` stays in its value");
        expect(AccessibleHypertextSource::attribute(L"font\\:family:x;display:inline;", L"font:family") == std::wstring(L"x"), "an escaped `:` stays in its name");
        expect(!AccessibleHypertextSource::attribute(L"tag:div;", L"display"), "no display attribute");
        expect(!AccessibleHypertextSource::attribute(L"displayed:block;disp:x;", L"display"), "a longer or shorter name is another");
        expect(AccessibleHypertextSource::attribute(L"display:inline", L"display") == std::wstring(L"inline"), "the last pair needs no `;`");

        richReads();
        // An offset inside a surrogate pair, or past the text, is the provider's error.
        const std::wstring pair = L"\U0001F600";
        expect(AccessibleHypertextSource::scalars(pair, 2) == 1, "a whole pair is one scalar");
        expect(throws([&] { AccessibleHypertextSource::scalars(pair, 1); }), "an offset inside a pair is refused");
        expect(throws([&] { AccessibleHypertextSource::scalars(pair, 3); }), "an offset past the text is refused");

        std::cout << "IAccessible2 hypertext adapter passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
