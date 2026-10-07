// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#include "uia_caret_source.h"
#include "edit_caret_source.h"
#include <memory>
#include <iostream>

using namespace voice;
static void expect(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
// In-process COM ranges exercise the production adapter's calls and endpoint
// rules. Actual application/foreground acceptance is a separate integration gate.
#define UNKNOWN_INTERFACE(Type) \
 HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** result) override { \
  *result = nullptr; if (iid == __uuidof(IUnknown) || iid == __uuidof(Type)) *result = static_cast<Type*>(this); \
  return *result ? S_OK : E_NOINTERFACE; } \
 ULONG STDMETHODCALLTYPE AddRef() override { return 2; } \
 ULONG STDMETHODCALLTYPE Release() override { return 1; }
struct Provider;
struct Range final : IUIAutomationTextRange {
    Provider& owner; int start, end;
    // A block's range, and a range that ends where a block's starts.
    bool block = false, endsAtBlock = false;
    Range(Provider& p, int a, int b) : owner(p), start(a), end(b) {}
    UNKNOWN_INTERFACE(IUIAutomationTextRange)
    int endpoint(TextPatternRangeEndpoint e) const { return e == TextPatternRangeEndpoint_Start ? start : end; }
    void set(TextPatternRangeEndpoint e, int value) {
        if (e == TextPatternRangeEndpoint_Start) { start = value; end = std::max(end, start); }
        else { end = value; start = std::min(start, end); }
    }
    HRESULT STDMETHODCALLTYPE Clone(IUIAutomationTextRange** result) override;
    HRESULT STDMETHODCALLTYPE Compare(IUIAutomationTextRange* other, BOOL* same) override {
        const auto* r = static_cast<Range*>(other); *same = start == r->start && end == r->end; return S_OK;
    }
    HRESULT STDMETHODCALLTYPE CompareEndpoints(TextPatternRangeEndpoint a, IUIAutomationTextRange* other, TextPatternRangeEndpoint b, int* result) override;
    HRESULT STDMETHODCALLTYPE MoveEndpointByRange(TextPatternRangeEndpoint a, IUIAutomationTextRange* other, TextPatternRangeEndpoint b) override {
        if (a == TextPatternRangeEndpoint_End) endsAtBlock = b == TextPatternRangeEndpoint_Start && static_cast<Range*>(other)->block;
        set(a, static_cast<Range*>(other)->endpoint(b)); return S_OK;
    }
    HRESULT STDMETHODCALLTYPE MoveEndpointByUnit(TextPatternRangeEndpoint e, TextUnit unit, int count, int* moved) override;
    HRESULT STDMETHODCALLTYPE GetText(int maximum, BSTR* result) override;
    HRESULT STDMETHODCALLTYPE ExpandToEnclosingUnit(TextUnit unit) override;
    HRESULT STDMETHODCALLTYPE FindAttribute(TEXTATTRIBUTEID, VARIANT, BOOL, IUIAutomationTextRange**) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE FindText(BSTR, BOOL, BOOL, IUIAutomationTextRange**) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE GetAttributeValue(TEXTATTRIBUTEID, VARIANT*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE GetBoundingRectangles(SAFEARRAY**) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE GetEnclosingElement(IUIAutomationElement**) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE Move(TextUnit, int, int*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE Select() override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE AddToSelection() override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE RemoveFromSelection() override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE ScrollIntoView(BOOL) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE GetChildren(IUIAutomationElementArray**) override { return E_NOTIMPL; }
};
struct Selection final : IUIAutomationTextRangeArray {
    Provider& owner;
    explicit Selection(Provider& p) : owner(p) {}
    UNKNOWN_INTERFACE(IUIAutomationTextRangeArray)
    HRESULT STDMETHODCALLTYPE get_Length(int* count) override { *count = 1; return S_OK; }
    HRESULT STDMETHODCALLTYPE GetElement(int index, IUIAutomationTextRange** range) override;
};
struct Visible final : IUIAutomationTextRangeArray {
    Provider& owner;
    explicit Visible(Provider& p) : owner(p) {}
    UNKNOWN_INTERFACE(IUIAutomationTextRangeArray)
    HRESULT STDMETHODCALLTYPE get_Length(int* count) override;
    HRESULT STDMETHODCALLTYPE GetElement(int index, IUIAutomationTextRange** range) override;
};
struct Provider final : IUIAutomationTextPattern2 {
    std::wstring text;
    int docStart = 10, docEnd, selectedStart, selectedEnd, unitSize = 1;
    unsigned reads = 0, outsideReads = 0, documentReads = 0;
    std::optional<int> reportedDocumentEnd;
    bool changeSelection = false, changeText = false;
    bool pattern2 = false, caretActive = true, changeCaret = false;
    int caretPosition = 0, caretWidth = 0, caretReads = 0;
    HRESULT caretStatus = S_OK;
    std::vector<int> caps;
    // Where the provider's paragraphs and lines start, from the field's start; none: it has none.
    std::vector<int> paragraphs, lines;
    std::vector<std::array<int,2>> readSpans;
    // A span whose text the provider gives differently from the rest of its text.
    std::optional<std::array<int,2>> misread;
    // Chromium reads from a caret ending a paragraph up to the start of the block after it as that
    // paragraph's break: both are at one offset in its text, the caret first (measured in Electron).
    bool breakAtCaret = false;
    std::vector<std::unique_ptr<Range>> ranges;
    Selection selected{*this};
    Visible visible{*this};
    std::vector<std::array<int,2>> visibleSpans;
    int visibilityReads = 0;
    bool changeVisibility = false;
    std::string field() {
        VisibleContext context;
        UiaCaretSource::appendField(this, context, {});
        return context.render();
    }
    Provider(std::wstring field, int start, int end)
        : text(std::wstring(10, L'!') + field + std::wstring(10, L'!')),
          docEnd(10 + static_cast<int>(field.size())), selectedStart(10 + start), selectedEnd(10 + end) {}
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** result) override {
        *result = nullptr;
        if (iid == __uuidof(IUnknown) || iid == __uuidof(IUIAutomationTextPattern))
            *result = static_cast<IUIAutomationTextPattern*>(this);
        else if (pattern2 && iid == __uuidof(IUIAutomationTextPattern2))
            *result = static_cast<IUIAutomationTextPattern2*>(this);
        return *result ? S_OK : E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return 2; }
    ULONG STDMETHODCALLTYPE Release() override { return 1; }
    HRESULT STDMETHODCALLTYPE RangeFromAnnotation(IUIAutomationElement*, IUIAutomationTextRange**) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE GetCaretRange(BOOL* active, IUIAutomationTextRange** result) override {
        ++caretReads;
        *active = caretActive ? TRUE : FALSE;
        *result = nullptr;
        if (FAILED(caretStatus)) return caretStatus;
        const int position = docStart + caretPosition + (changeCaret && caretReads > 1 ? 1 : 0);
        *result = range(position, position + caretWidth);
        return S_OK;
    }
    Range* range(int a, int b) { ranges.push_back(std::make_unique<Range>(*this, a, b)); return ranges.back().get(); }
    HRESULT STDMETHODCALLTYPE GetSelection(IUIAutomationTextRangeArray** result) override { *result = &selected; return S_OK; }
    HRESULT STDMETHODCALLTYPE get_DocumentRange(IUIAutomationTextRange** result) override { ++documentReads; *result = range(docStart, reportedDocumentEnd.value_or(docEnd)); return S_OK; }
    HRESULT STDMETHODCALLTYPE RangeFromPoint(POINT, IUIAutomationTextRange**) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE RangeFromChild(IUIAutomationElement*, IUIAutomationTextRange**) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE GetVisibleRanges(IUIAutomationTextRangeArray** result) override {
        ++visibilityReads;
        if (changeVisibility && visibilityReads > 1 && !visibleSpans.empty()) ++visibleSpans[0][0];
        *result = &visible; return S_OK;
    }
    HRESULT STDMETHODCALLTYPE get_SupportedTextSelection(SupportedTextSelection* value) override { *value = SupportedTextSelection_Single; return S_OK; }
    CaretSource read() { return UiaCaretSource::read(this); }
    CaretSource read(const UiaCaretSource::LayoutRead& layout) { return UiaCaretSource::read(this, layout); }
    std::optional<std::string> readPage() {
        return UiaCaretSource::selectedText(this, range(selectedStart, selectedEnd), range(docStart, docEnd));
    }
};
HRESULT Visible::get_Length(int* count) { *count = static_cast<int>(owner.visibleSpans.size()); return S_OK; }
HRESULT Visible::GetElement(int index, IUIAutomationTextRange** result) {
    if (index < 0 || static_cast<size_t>(index) >= owner.visibleSpans.size()) return E_INVALIDARG;
    const auto span = owner.visibleSpans[index]; *result = owner.range(span[0], span[1]); return S_OK;
}
HRESULT Range::CompareEndpoints(TextPatternRangeEndpoint a, IUIAutomationTextRange* other, TextPatternRangeEndpoint b, int* result) {
    const auto* r = static_cast<Range*>(other);
    const int x = endpoint(a), y = r->endpoint(b); *result = (x > y) - (x < y);
    // Where Chromium reads a break (`breakAtCaret`), a block starts after a caret at its offset.
    if (!*result && owner.breakAtCaret && block != r->block)
        *result = (block ? a : b) == TextPatternRangeEndpoint_Start ? (block ? 1 : -1) : 0;
    return S_OK;
}
HRESULT Range::Clone(IUIAutomationTextRange** result) { *result = owner.range(start, end); return S_OK; }
HRESULT Selection::GetElement(int index, IUIAutomationTextRange** result) {
    if (index != 0) return E_INVALIDARG;
    *result = owner.range(owner.selectedStart, owner.selectedEnd); return S_OK;
}
HRESULT Range::MoveEndpointByUnit(TextPatternRangeEndpoint e, TextUnit unit, int count, int* moved) {
    if (unit != TextUnit_Character) return E_INVALIDARG;
    const auto requested = static_cast<int64_t>(endpoint(e)) + static_cast<int64_t>(count) * owner.unitSize;
    const int target = static_cast<int>(std::clamp<int64_t>(requested, 0, static_cast<int64_t>(owner.text.size())));
    *moved = (target - endpoint(e)) / owner.unitSize; set(e, target); return S_OK;
}
HRESULT Range::ExpandToEnclosingUnit(TextUnit unit) {
    const auto& starts = unit == TextUnit_Paragraph ? owner.paragraphs : unit == TextUnit_Line ? owner.lines : std::vector<int>{};
    if (starts.empty()) return E_NOTIMPL;
    int unitStart = owner.docStart, unitEnd = owner.docEnd;
    for (const int at : starts) {
        if (owner.docStart + at <= start) unitStart = owner.docStart + at;
        else { unitEnd = owner.docStart + at; break; }
    }
    start = unitStart; end = unitEnd; return S_OK;
}
HRESULT Range::GetText(int maximum, BSTR* result) {
    ++owner.reads; owner.caps.push_back(maximum); owner.readSpans.push_back({start,end});
    if (start < owner.docStart || end > owner.docEnd) ++owner.outsideReads;
    if (maximum < 0 || start < 0 || end < start || static_cast<size_t>(end) > owner.text.size()) return E_INVALIDARG;
    if (owner.breakAtCaret && endsAtBlock && start == owner.selectedEnd && end == start && maximum > 0) {
        *result = SysAllocString(L"\n");
        return S_OK;
    }
    const auto count = static_cast<UINT>(std::min(end - start, maximum));
    *result = SysAllocStringLen(owner.text.data() + start, count);
    if (owner.misread == std::array<int,2>{start, end} && count) (*result)[0] = L'Z';
    if (owner.changeSelection) { ++owner.selectedStart; ++owner.selectedEnd; owner.changeSelection = false; }
    if (owner.changeText) { owner.text.at(static_cast<size_t>(owner.selectedStart)) = L'Z'; owner.changeText = false; }
    return *result || count == 0 ? S_OK : E_OUTOFMEMORY;
}
// Hidden real standard Edit controls exercise system message semantics without
// taking focus or depending on the logged-in desktop's foreground owner.
struct EditFixture {
    HWND window = nullptr;
    WNDPROC original = nullptr;
    int reads = 0;
    bool moveSelection = false, replaceText = false;
    EditFixture(const std::wstring& value, DWORD start, DWORD end, DWORD extraStyle = 0) {
        window = CreateWindowExW(0, L"Edit", L"", WS_POPUP | ES_MULTILINE | ES_AUTOHSCROLL | extraStyle,
            0, 0, 400, 200, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
        if (!window) throw std::runtime_error("edit fixture creation failed: " + std::to_string(GetLastError()));
        if (!SendMessageW(window, WM_SETTEXT, 0, reinterpret_cast<LPARAM>(value.c_str())))
            throw std::runtime_error("edit fixture text rejected at length " + std::to_string(value.size()));
        SendMessageW(window, EM_SETSEL, start, end);
        SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(this));
        original = reinterpret_cast<WNDPROC>(SetWindowLongPtrW(window, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(&dispatch)));
    }
    ~EditFixture() { DestroyWindow(window); }
    static LRESULT CALLBACK dispatch(HWND window, UINT message, WPARAM wp, LPARAM lp) {
        auto& fixture = *reinterpret_cast<EditFixture*>(GetWindowLongPtrW(window, GWLP_USERDATA));
        const auto result = CallWindowProcW(fixture.original, window, message, wp, lp);
        if (message == WM_GETTEXT) {
            ++fixture.reads;
            if (fixture.moveSelection) {
                fixture.moveSelection = false;
                SendMessageW(window, EM_SETSEL, 0, 1);
            }
            if (fixture.replaceText) {
                fixture.replaceText = false;
                SendMessageW(window, WM_SETTEXT, 0, reinterpret_cast<LPARAM>(L"before CHOSEN after"));
                SendMessageW(window, EM_SETSEL, 7, 13);
            }
        }
        return result;
    }
    std::optional<CaretSource> read() { return EditCaretSource::read(window); }
};
static void editContracts() {
    const HWND foreground = GetForegroundWindow();
    EditFixture normal(L"before " + std::wstring(20001, L's') + L" after", 7, 20008);
    auto result = normal.read();
    expect(result && !result->selectionUnavailable && result->parts[1] == std::string(20001, 's'), "Edit complete selection beyond historical limit");
    EditFixture distant(std::wstring(70000, L'a') + L". chosen after", 70002, 70008);
    result = distant.read();
    expect(result && !result->selectionUnavailable && result->parts[1] == "chosen", "Edit full DWORD selection offsets beyond 65535");
    EditFixture oversized(std::wstring(262139, L's'), 0, 262139);
    result = oversized.read();
    expect(result && result->selectionUnavailable, "Edit shared UTF8 selection overflow refused intact");
    const auto limit = core::request({{"limits", true}}, voice_core_context_json).at("caretSourceBytes").get<size_t>();
    EditFixture huge(std::wstring(limit + 1, L'x'), 0, 1);
    result = huge.read();
    expect(result && result->selectionUnavailable && huge.reads == 0, "Edit whole-transfer overflow refused before text allocation");
    EditFixture hugeCaret(std::wstring(limit + 1, L'x'), 0, 0);
    result = hugeCaret.read();
    expect(result && !result->selectionUnavailable && result->parts == std::array<std::string, 3>{"", "", ""} && hugeCaret.reads == 0,
        "Edit whole-transfer overflow at a caret is an empty window, never read");
    EditFixture password(L"synthetic", 0, 9, ES_PASSWORD);
    expect(!password.read() && password.reads == 0, "Edit password never read");
    EditFixture moved(L"before chosen after", 7, 13); moved.moveSelection = true;
    result = moved.read();
    expect(result && result->selectionUnavailable, "Edit changed selection refused");
    EditFixture changed(L"before chosen after", 7, 13); changed.replaceText = true;
    result = changed.read();
    expect(result && result->selectionUnavailable, "Edit same-length content change refused");
    // A caret selects nothing: one whose field changed while read is an empty window, not a withheld
    // selection, so agent mode writes at it rather than refuse a selection there is none of.
    EditFixture caretMoved(L"before chosen after", 7, 7); caretMoved.moveSelection = true;
    result = caretMoved.read();
    expect(result && !result->selectionUnavailable && result->parts == std::array<std::string, 3>{"", "", ""}, "Edit changed caret is an empty window");
    expect(GetForegroundWindow() == foreground, "hidden Edit tests preserve foreground");
}
static void viewportContracts() {
    const auto capture = [](Provider& p, bool focused = true, size_t budget = 262144) {
        return UiaCaretSource::viewportSurface(&p, 1, {0,0,400,200}, focused, budget);
    };
    const auto visibleOnly = [](const Provider& p) {
        return std::all_of(p.readSpans.begin(), p.readSpans.end(), [&](const auto& read) {
            return std::any_of(p.visibleSpans.begin(), p.visibleSpans.end(), [&](const auto& visible) {
                return read[0] >= visible[0] && read[1] <= visible[1];
            });
        });
    };
    for (const auto& text : {std::wstring(), std::wstring(L"entirely hidden text")}) {
        Provider emptyVisible(text, 0, 0);
        emptyVisible.visibleSpans = {{emptyVisible.docStart,emptyVisible.docStart}};
        const auto unavailable = capture(emptyVisible);
        expect(unavailable.at("caret").at("status") == "unavailable",
            "degenerate visibility cannot prove an on-screen caret for empty or hidden content");
        expect(visibleOnly(emptyVisible), "degenerate visibility never acquires hidden text");
        emptyVisible.pattern2 = true;
        expect(capture(emptyVisible).at("caret").at("status") == "unavailable",
            "Pattern2 caret still needs nondegenerate visible text identity");
    }
    const std::wstring shown = L"first line\n> hello world\nstatus bar\n  ";
    Provider reference(L"HIDDEN!" + shown + L"HIDDEN!", 7+18, 7+18);
    reference.visibleSpans = {{reference.docStart+7,reference.docEnd-7}};
    const auto result = capture(reference);
    expect(result.at("surface").at("runs")[0].at("text") == utf8(shown), "whole visible terminal including whitespace retained");
    expect(result.at("caret").at("status") == "exact" && result.at("caret").at("offset") == 18, "Mac reference caret from native UIA endpoint");
    expect(visibleOnly(reference), "no hidden source read for reference caret");
    // Windows Terminal 1.24 exposes the full viewport, while DocumentRange ends
    // on the line beneath the cursor/last text. Blank visible rows may exceed it.
    Provider blankRows(L"HIDDEN!prompt  \r\n    \r\n    HIDDEN!", 7+8, 7+8);
    blankRows.reportedDocumentEnd = blankRows.docStart+7+10;
    blankRows.visibleSpans = {{blankRows.docStart+7,blankRows.docEnd-7}};
    const auto blankRowsResult = capture(blankRows);
    expect(blankRowsResult.at("surface").at("runs")[0].at("text") == "prompt  \r\n    \r\n    ",
        "visible blank rows beyond provider document end are preserved");
    expect(blankRowsResult.at("caret").at("status") == "exact" && blankRowsResult.at("caret").at("offset") == 8,
        "cursor before trailing blank rows retains exact UTF16 position");
    expect(blankRows.documentReads == 0 && visibleOnly(blankRows), "terminal capture uses visible ranges without document acquisition");
    blankRows.selectedStart = blankRows.docStart+7+10;
    blankRows.selectedEnd = blankRows.docEnd-7;
    const auto blankSelection = capture(blankRows);
    expect(blankSelection.at("surface").at("selection").at("complete") == true &&
        blankSelection.at("surface").at("selection").at("ranges")[0].at("start") == 10 &&
        blankSelection.at("surface").at("selection").at("ranges")[0].at("end") == 20 && visibleOnly(blankRows),
        "selection in visible rows beyond document end is preserved without hidden reads");
    Provider selected(L"HIDDEN!left selected rightHIDDEN!", 12, 20);
    selected.visibleSpans = {{selected.docStart+7,selected.docEnd-7}};
    const auto selectedResult = capture(selected);
    expect(selectedResult.at("caret").at("status") == "unavailable", "explicit selection does not invent a cursor");
    expect(selectedResult.at("surface").at("selection").at("complete") == true && visibleOnly(selected), "complete visible selection without halo reads");
    Provider independent(L"HIDDEN!left selected rightHIDDEN!", 12, 20);
    independent.pattern2=true; independent.caretPosition=7+17;
    independent.visibleSpans={{independent.docStart+7,independent.docEnd-7}};
    const auto independentResult=capture(independent);
    expect(independentResult.at("caret").at("status")=="exact" && independentResult.at("caret").at("offset")==17,
        "Pattern2 caret independent of explicit selection");
    const auto& independentSelection=independentResult.at("surface").at("selection");
    expect(independentSelection.at("complete")==true && independentSelection.at("ranges")[0].at("start")==5 &&
        independentSelection.at("ranges")[0].at("end")==13 && visibleOnly(independent), "Pattern2 preserves independent selection offsets");
    independent.caretActive=false;
    expect(capture(independent).at("caret").at("status")=="unavailable", "inactive Pattern2 caret is not a focused cursor");
    independent.caretActive=true; independent.caretStatus=E_FAIL;
    expect(capture(independent).at("caret").at("status")=="unavailable", "failed Pattern2 does not guess from selection");
    independent.caretStatus=S_OK; independent.caretWidth=1;
    expect(capture(independent).at("caret").at("status")=="unavailable", "noncollapsed Pattern2 caret refused");
    independent.caretWidth=0; independent.caretPosition=0;
    expect(capture(independent).at("caret").at("status")=="outsideViewport" && visibleOnly(independent), "offscreen Pattern2 caret does not acquire hidden text");
    independent.caretPosition=7+17; independent.caretReads=0;
    expect(capture(independent,false).at("caret").at("status")=="unavailable" && independent.caretReads==0, "unfocused split never queries Pattern2 caret");
    independent.changeCaret=true; independent.caretReads=0;
    // The screen as at key-down (owner, 2026-10-05): a cursor that moves after the read keeps the one read.
    const auto movedCaret=capture(independent);
    expect(movedCaret.at("caret").at("status")=="exact" && movedCaret.at("caret").at("offset")==17 && visibleOnly(independent),
        "Pattern2 cursor moving after the read keeps the key-down cursor");
    Provider away(L"HIDDEN!shownHIDDEN!", 0, 0); away.visibleSpans={{away.docStart+7,away.docEnd-7}};
    expect(capture(away).at("caret").at("status") == "outsideViewport" && visibleOnly(away), "offscreen cursor never read or guessed");
    Provider gap(L"leftHIDDENright", 0, 15); gap.visibleSpans={{gap.docStart,gap.docStart+4},{gap.docStart+10,gap.docEnd}};
    const auto gapResult = capture(gap);
    expect(gapResult.at("surface").at("runs").size()==2 && gapResult.at("surface").at("runs")[1].at("connected")==false, "disjoint visibility remains disjoint");
    expect(gapResult.at("surface").at("selection").at("complete")==false && visibleOnly(gap), "selection across hidden gap is incomplete without reading gap");
    Provider unicode(L"HIDDEN!界😀 hello worldHIDDEN!", 7+9, 7+9); unicode.visibleSpans={{unicode.docStart+7,unicode.docEnd-7}};
    const auto unicodeResult=capture(unicode);
    expect(unicodeResult.at("caret").at("offset")==9 && visibleOnly(unicode), "native UTF16 offset survives wide and surrogate text");
    Provider changed(L"HIDDEN!hello worldHIDDEN!", 9, 9); changed.visibleSpans={{changed.docStart+7,changed.docEnd-7}}; changed.changeText=true;
    const auto changedResult=capture(changed);
    expect(changedResult.at("surface").at("runs")[0].at("text")=="hello world" && changedResult.at("caret").at("status")=="unavailable" && visibleOnly(changed),
        "output arriving during the read keeps the text read first; the cursor's place in it is then unknown");
    bool refused=false;
    Provider bounded(L"HIDDEN!visibleHIDDEN!", 9,9);bounded.visibleSpans={{bounded.docStart+7,bounded.docEnd-7}};
    refused=false;try{capture(bounded,true,1);}catch(const std::exception&){refused=true;}
    expect(refused && visibleOnly(bounded), "budget refusal never falls back to whole document");
}
int main() {
    {
        const auto caption = std::wstring(990, L'x') + L" AKIA" + std::wstring(16, L'A') + L". Long caption. ";
        Provider p(caption, 0, 0);
        const auto source = UiaCaretSource::rangeSource(p.range(p.docStart, p.docEnd));
        expect(source == utf8(caption), "caption acquisition preserves complete text beyond historical 1000-unit cut");
        std::array<std::string,3> caret{};
        // Render-only ordinary blocks do not finalize; explicitly exercise the
        // production shared redaction boundary through its context request.
        const auto redacted = core::request({{"blocks", {{{"kind", "text"}, {"text", source}}}}, {"caret", caret}}, voice_core_context_json);
        expect(redacted.at("rendered").get<std::string>().find("AKIA") == std::string::npos,
            "caption redaction sees a credential spanning the old cut");
    }
    {
        Provider p(L"private prefix Caption private suffix", 0, 0);
        p.docStart += 15; p.docEnd = p.docStart + 7;
        expect(UiaCaretSource::rangeSource(p.range(p.docStart, p.docEnd)) == "Caption" && p.outsideReads == 0,
            "approved child caption never reads surrounding document source");
    }
    {
        Provider p(L"Visible. password: " + std::wstring(600000, L'x'), 0, 0); p.unitSize = 7;
        expect(UiaCaretSource::rangeSource(p.range(p.docStart, p.docEnd)) == "Visible. ",
            "oversize caption keeps closed prefix but withholds incomplete credential");
    }
    {
        Provider p(L"Caption", 0, 0); p.changeText = true;
        bool refused = false;
        try { (void)UiaCaretSource::rangeSource(p.range(p.docStart, p.docEnd)); }
        catch (const std::exception&) { refused = true; }
        expect(refused, "changed caption cannot become accepted source");
    }

    {
        Provider p(L"Short field", 0, 0);
        expect(p.field() == "> Short field" && p.visibilityReads == 0, "small whole field keeps all text");
    }
    {
        std::wstring value; for (int i = 0; i < 15000; ++i) value += L"😀";
        Provider p(value, 0, 0);
        expect(!p.field().empty() && p.visibilityReads == 0, "whole-field policy uses graphemes rather than UIA units");
    }
    {
        Provider p(std::wstring(300000, L'x') + L". password: syntheticSecret123. End. ", 0, 0);
        const int start = static_cast<int>(p.text.find(L"syntheticSecret123"));
        p.visibleSpans = {{start, start + 18}}; p.unitSize = 7;
        const auto result = p.field();
        expect(result.find("[redacted]") != std::string::npos && result.find("syntheticSecret") == std::string::npos,
            "opaque side movement retains credential context for redaction");
        expect(result.find("password:") == std::string::npos && p.outsideReads == 0 && p.visibilityReads == 2,
            "private context never renders and provider endpoints stay within document");
    }
    {
        Provider p(std::wstring(300000, L'x') + L". Visible. End. ", 0, 0);
        p.visibleSpans = {{300012, 300020}}; p.changeVisibility = true;
        bool refused = false; try { (void)p.field(); } catch (const std::exception&) { refused = true; }
        expect(refused, "changed visible ranges cannot commit partial field");
    }
    {
        Provider p(L"Visible sentence. " + std::wstring(300000, L'x'), 0, 0);
        p.visibleSpans = {{p.docStart, p.docEnd}}; p.unitSize = 9;
        expect(p.field().find("Visible sentence.") != std::string::npos && p.outsideReads == 0,
            "oversize visible range retains bounded prefix with opaque movement");
    }
    {
        Provider p(std::wstring(300000, L'x'), 0, 0);
        p.visibleSpans = {{p.docStart - 1, p.docStart + 5}};
        bool refused = false; try { (void)p.field(); } catch (const std::exception&) { refused = true; }
        expect(refused && p.outsideReads == 0, "out-of-document visible span refused before acquisition");
    }

    try {
        const std::wstring selection(20001, L's');
        Provider ordinary(L"Before " + selection + L" after", 7, 7 + static_cast<int>(selection.size()));
        auto result = ordinary.read();
        expect(!result.selectionUnavailable && result.parts[1] == std::string(20001, 's'), "complete selection beyond historical 2000 limit");
        expect(ordinary.outsideReads == 0, "field boundary clamps precede text reads");
        std::wstring exact = L"a";
        for (size_t i = 0; i < 65534; ++i) exact += L"\U0001F600";
        exact += L"x";
        Provider unicode(exact, 0, static_cast<int>(exact.size()));
        result = unicode.read();
        expect(!result.selectionUnavailable && result.parts[1].size() == 262138, "exact UTF8 selection limit");
        Provider oversized(std::wstring(262139, L's'), 0, 262139);
        result = oversized.read();
        expect(result.selectionUnavailable && result.parts[1] == "[redacted]", "oversized selection refused intact");
        const auto left = std::wstring(300000, L'a') + L". Before ";
        Provider largerUnits(left + selection + L" after! " + std::wstring(300000, L'b'), static_cast<int>(left.size()), static_cast<int>(left.size() + selection.size()));
        largerUnits.unitSize = 64;
        result = largerUnits.read();
        expect(!result.selectionUnavailable && result.parts[1] == std::string(20001, 's'), "larger text-unit fallback uses actual bounded text");
        expect(largerUnits.outsideReads == 0 && std::all_of(largerUnits.caps.begin(), largerUnits.caps.end(), [](int cap) { return cap > 0 && cap <= 262145; }), "every read bounded inside field");
        Provider outside(L"before chosen after", 0, 7); outside.selectedStart = 0;
        expect(outside.read().selectionUnavailable && outside.reads == 0, "out-of-field nonempty selection never clipped");
        Provider collapsed(L"plain", 5, 5); collapsed.selectedStart = collapsed.docEnd + 1; collapsed.selectedEnd = collapsed.selectedStart;
        result = collapsed.read();
        expect(!result.selectionUnavailable && result.parts[0] == "plain" && collapsed.outsideReads == 0, "collapsed Chromium end caret stays inside field");
        Provider moved(L"before chosen after", 7, 13); moved.changeSelection = true;
        expect(moved.read().selectionUnavailable, "changed selection refused");
        Provider changed(L"before chosen after", 7, 13); changed.changeText = true;
        expect(changed.read().selectionUnavailable, "same-length selected text change refused");
        Provider caretMoved(L"before chosen after", 7, 7); caretMoved.changeSelection = true;
        result = caretMoved.read();
        expect(!result.selectionUnavailable && result.parts == std::array<std::string, 3>{"", "", ""}, "changed caret is an empty window");
        Provider page(L"outside " + selection + L" outside", 8, 8 + static_cast<int>(selection.size()));
        expect(page.readPage() == std::optional<std::string>(std::string(20001, 's')), "page selection remains complete beyond old limit");
        expect(page.reads == 2 && std::all_of(page.ranges.begin(), page.ranges.end(), [&](const auto& range) {
            return (range->start == page.selectedStart && range->end == page.selectedEnd) ||
                (range->start == page.docStart && range->end == page.docEnd);
        }), "page selection does not acquire adjacent source");
        Provider pageLarge(std::wstring(262139, L's'), 0, 262139);
        expect(!pageLarge.readPage(), "page selection overflow refuses whole selection");
        Provider pageMoved(L"before chosen after", 7, 13); pageMoved.changeSelection = true;
        expect(!pageMoved.readPage(), "changed page selection refused");
        Provider pageChanged(L"before chosen after", 7, 13); pageChanged.changeText = true;
        expect(!pageChanged.readPage(), "same-length page selection change refused");
        Provider pageOutside(L"plain", 0, 5); pageOutside.selectedStart = 0;
        expect(!pageOutside.readPage() && pageOutside.reads == 0, "page selection outside document refused before text access");
        // Chromium gives an empty line no character: a caret there sits where the paragraph above
        // ends, on a line of its own that holds only that paragraph's break (measured in Electron).
        const std::wstring rich = L"Hi All,\nWhy does it move?\n--";
        const auto shape = [](Provider& provider, std::vector<int> paragraphs, std::vector<int> lines) {
            provider.paragraphs = std::move(paragraphs); provider.lines = std::move(lines);
        };
        Provider emptyLine(rich, 25, 25); shape(emptyLine, {0, 8, 26}, {0, 8, 25, 26});
        result = emptyLine.read();
        expect(!result.selectionUnavailable && result.parts[0] == "Hi All,\nWhy does it move?\n" && result.parts[2] == "\n--",
            "a caret starting an empty line ends its before-text in a line break");
        Provider leftOut(rich, 8, 8); leftOut.text.erase(leftOut.docStart + 7, 1); --leftOut.docEnd; --leftOut.selectedStart; --leftOut.selectedEnd;
        shape(leftOut, {0, 7, 24}, {0, 7, 24});
        result = leftOut.read();
        expect(!result.selectionUnavailable && result.parts[0] == "Hi All,\n" && result.parts[2] == "Why does it move?\n--",
            "a caret starting a paragraph whose break was left out gets it back");
        Provider spaceLeftOut(L"Hi All, Why", 8, 8); shape(spaceLeftOut, {0, 8}, {0, 8});
        result = spaceLeftOut.read();
        expect(!result.selectionUnavailable && result.parts[0] == "Hi All, \n", "a left-out break after a trailing space comes back too");
        Provider wrapped(L"https://example.com/a/link/longer/than/its/line", 20, 20); shape(wrapped, {0}, {0, 20});
        result = wrapped.read();
        expect(!result.selectionUnavailable && result.parts[0] == "https://example.com/", "a caret starting a wrapped line inside a paragraph gets no break");
        Provider sentenceEnd(rich, 25, 25); shape(sentenceEnd, {0, 8, 26}, {0, 8, 26});
        result = sentenceEnd.read();
        expect(!result.selectionUnavailable && result.parts[0] == "Hi All,\nWhy does it move?", "a caret ending a sentence gets no break");
        Provider shownBreak(rich, 8, 8); shape(shownBreak, {0, 8, 26}, {0, 8, 26});
        result = shownBreak.read();
        expect(!result.selectionUnavailable && result.parts[0] == "Hi All,\n", "a paragraph start whose break shows gets no second one");
        Provider fieldStart(rich, 0, 0); shape(fieldStart, {0, 8, 26}, {0, 8, 26});
        result = fieldStart.read();
        expect(!result.selectionUnavailable && result.parts[0].empty(), "a caret at the field's start gets no break");
        Provider selectedLine(rich, 25, 27); shape(selectedLine, {0, 8, 26}, {0, 8, 25, 26});
        result = selectedLine.read();
        expect(!result.selectionUnavailable && result.parts[0] == "Hi All,\nWhy does it move?\n" && result.parts[1] == "\n-",
            "a selection starting an empty line ends the text before it in a break");
        Provider noLines(rich, 25, 25); noLines.paragraphs = {0, 8, 26};
        result = noLines.read();
        expect(!result.selectionUnavailable && result.parts[0] == "Hi All,\nWhy does it move?", "a provider without lines gets no break");
        // A rich editor's blocks, as Chromium lays them out, give back the breaks its text leaves
        // out: the field's tree (node 0), where each node's text is, and the element the caret is in.
        struct Node { int start, end; bool block; std::vector<int> children; };
        const auto layout = [](Provider& provider, const std::vector<Node>& nodes, std::optional<int> caretNode, size_t elements = 300) {
            return UiaCaretSource::LayoutRead([&provider, nodes, caretNode, elements](IUIAutomationTextRange* selected, IUIAutomationTextRange* low, IUIAutomationTextRange* high)
                -> std::optional<UiaCaretSource::Layout> {
                const auto place = [&](int node) {
                    auto* range = provider.range(provider.docStart + nodes[node].start, provider.docStart + nodes[node].end);
                    range->block = true;
                    return ComPtr<IUIAutomationTextRange>(range);
                };
                auto starts = UiaCaretSource::blockStarts(0, low, high, elements, [&](int node) { return nodes[node].children; },
                    [&](int node) { return nodes[node].block; }, place);
                if (!starts) return std::nullopt;
                return UiaCaretSource::Layout{std::move(*starts), UiaCaretSource::endsLine(caretNode ? place(*caretNode).Get() : nullptr, selected)};
            });
        };
        const std::string added = "\xE2\x80\xA9";
        // Measured in Electron: a line, an empty paragraph, the line dictated under in runs of text,
        // then the signature block, which starts with two empty lines.
        const std::wstring gmail = L"Synthetic opening line\nSynthetic line to dictate under.\n\n--\nSynthetic signature";
        const std::vector<Node> gmailTree{{0, 79, false, {1, 2, 3, 4}}, {0, 22, false, {}}, {22, 23, true, {}},
                                          {23, 55, true, {5, 6}}, {55, 79, true, {}}, {23, 33, false, {}}, {33, 55, false, {}}};
        Provider signatureStart(gmail, 55, 55);
        result = signatureStart.read(layout(signatureStart, gmailTree, 4));
        expect(!result.selectionUnavailable && result.parts[0] == "Synthetic opening line" + added + "\nSynthetic line to dictate under." + added &&
            result.parts[2] == "\n\n--\nSynthetic signature", "each block start after text gets its break back, the caret's before it");
        Provider lineEnd(gmail, 55, 55); lineEnd.breakAtCaret = true;
        result = lineEnd.read(layout(lineEnd, gmailTree, 3));
        expect(!result.selectionUnavailable && result.parts[0] == "Synthetic opening line" + added + "\nSynthetic line to dictate under." &&
            result.parts[2] == added + "\n\n--\nSynthetic signature", "a caret ending the line above a block gets that block's break after it");
        Provider tooMany(gmail, 55, 55);
        result = tooMany.read(layout(tooMany, gmailTree, 4, 3));
        expect(!result.selectionUnavailable && result.parts[0] == "Synthetic opening line\nSynthetic line to dictate under.",
            "blocks past the element budget give no starts, and no break");
        Provider misread(gmail, 55, 55); misread.misread = std::array<int,2>{misread.docStart + 23, misread.docStart + 55};
        result = misread.read(layout(misread, gmailTree, 4));
        expect(!result.selectionUnavailable && result.parts[0] == "Synthetic opening line\nSynthetic line to dictate under.",
            "a provider whose text between a block and the caret disagrees gives no starts");
        // A block start in a selection gets its break there; one after it, in the text after it.
        Provider inSelection(L"First paragraphSecondThird", 10, 18);
        result = inSelection.read(layout(inSelection, {{0, 26, false, {1, 2, 3}}, {0, 15, true, {}}, {15, 21, true, {}}, {21, 26, true, {}}}, 1));
        expect(!result.selectionUnavailable && result.parts[0] == "First para" && result.parts[1] == "graph" + added + "Sec" &&
            result.parts[2] == "ond" + added + "Third", "block starts in and after a selection get their breaks");
        // Only blocks within the core's paragraph-start stretch of the caret are looked at: halving
        // past the many before it, stopping at the first past it.
        const int units = core::request({{"limits", true}}, voice_core_context_json).at("paragraphStartUnits").get<int>();
        std::vector<Node> farTree{{0, 0, false, {}}};
        std::wstring longText;
        const auto block = [&](std::wstring text) {
            farTree[0].children.push_back(static_cast<int>(farTree.size()));
            farTree.push_back({static_cast<int>(longText.size()), static_cast<int>(longText.size() + text.size()), true, {}});
            longText += text;
        };
        for (int index = 0; index < 400; ++index) block(L"a");
        block(std::wstring(static_cast<size_t>(units) + 1000, L'b'));
        const int caret = static_cast<int>(longText.size()) + 2;
        block(L"ccccc");
        block(std::wstring(static_cast<size_t>(units) + 100, L'd'));
        for (int index = 0; index < 400; ++index) block(L"e");
        farTree[0].end = static_cast<int>(longText.size());
        Provider distant(longText, caret, caret);
        result = distant.read(layout(distant, farTree, 402));
        expect(!result.selectionUnavailable && result.parts[0] == std::string(400, 'a') + std::string(static_cast<size_t>(units) + 1000, 'b') + added + "cc" &&
            result.parts[2] == "ccc" + added + std::string(static_cast<size_t>(units) + 100, 'd') + std::string(400, 'e'),
            "only the block starts near the caret are looked at");
        viewportContracts();
        editContracts();
        std::cout << "UIA and Edit caret acquisition contracts passed\n";
        return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
