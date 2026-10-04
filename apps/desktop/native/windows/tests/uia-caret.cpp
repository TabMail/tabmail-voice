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
    HRESULT STDMETHODCALLTYPE CompareEndpoints(TextPatternRangeEndpoint a, IUIAutomationTextRange* other, TextPatternRangeEndpoint b, int* result) override {
        const int x = endpoint(a), y = static_cast<Range*>(other)->endpoint(b); *result = (x > y) - (x < y); return S_OK;
    }
    HRESULT STDMETHODCALLTYPE MoveEndpointByRange(TextPatternRangeEndpoint a, IUIAutomationTextRange* other, TextPatternRangeEndpoint b) override {
        set(a, static_cast<Range*>(other)->endpoint(b)); return S_OK;
    }
    HRESULT STDMETHODCALLTYPE MoveEndpointByUnit(TextPatternRangeEndpoint e, TextUnit unit, int count, int* moved) override;
    HRESULT STDMETHODCALLTYPE GetText(int maximum, BSTR* result) override;
    HRESULT STDMETHODCALLTYPE ExpandToEnclosingUnit(TextUnit) override { return E_NOTIMPL; }
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
    std::vector<std::array<int,2>> readSpans;
    std::vector<std::unique_ptr<Range>> ranges;
    Selection selected{*this};
    Visible visible{*this};
    std::vector<std::array<int,2>> visibleSpans;
    int visibilityReads = 0;
    bool changeVisibility = false;
    std::string field() {
        VisibleContext context;
        UiaCaretSource::appendField(this, context, {}, GetTickCount64());
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
    CaretSource read() { return UiaCaretSource::read(this, GetTickCount64()); }
    std::optional<std::string> readPage() {
        return UiaCaretSource::selectedText(this, range(selectedStart, selectedEnd), range(docStart, docEnd), GetTickCount64());
    }
};
HRESULT Visible::get_Length(int* count) { *count = static_cast<int>(owner.visibleSpans.size()); return S_OK; }
HRESULT Visible::GetElement(int index, IUIAutomationTextRange** result) {
    if (index < 0 || static_cast<size_t>(index) >= owner.visibleSpans.size()) return E_INVALIDARG;
    const auto span = owner.visibleSpans[index]; *result = owner.range(span[0], span[1]); return S_OK;
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
HRESULT Range::GetText(int maximum, BSTR* result) {
    ++owner.reads; owner.caps.push_back(maximum); owner.readSpans.push_back({start,end});
    if (start < owner.docStart || end > owner.docEnd) ++owner.outsideReads;
    if (maximum < 0 || start < 0 || end < start || static_cast<size_t>(end) > owner.text.size()) return E_INVALIDARG;
    const auto count = static_cast<UINT>(std::min(end - start, maximum));
    *result = SysAllocStringLen(owner.text.data() + start, count);
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
    std::optional<CaretSource> read() { return EditCaretSource::read(window, GetTickCount64()); }
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
    EditFixture password(L"synthetic", 0, 9, ES_PASSWORD);
    expect(!password.read() && password.reads == 0, "Edit password never read");
    EditFixture moved(L"before chosen after", 7, 13); moved.moveSelection = true;
    result = moved.read();
    expect(result && result->selectionUnavailable, "Edit changed selection refused");
    EditFixture changed(L"before chosen after", 7, 13); changed.replaceText = true;
    result = changed.read();
    expect(result && result->selectionUnavailable, "Edit same-length content change refused");
    EditFixture expired(L"plain", 0, 5); bool timedOut = false;
    try { EditCaretSource::read(expired.window, GetTickCount64() - 1501); } catch (const std::exception&) { timedOut = true; }
    expect(timedOut && expired.reads == 0, "Edit expired deadline prevents text acquisition");
    expect(GetForegroundWindow() == foreground, "hidden Edit tests preserve foreground");
}
static void viewportContracts() {
    const auto capture = [](Provider& p, bool focused = true, size_t budget = 262144) {
        return UiaCaretSource::viewportSurface(&p, 1, {0,0,400,200}, focused, budget, GetTickCount64());
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
    bool movedCaretRefused=false;
    try { capture(independent); } catch(const std::exception&) { movedCaretRefused=true; }
    expect(movedCaretRefused && visibleOnly(independent), "Pattern2 cursor mutation invalidates capture");
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
    bool refused=false;try{capture(changed);}catch(const std::exception&){refused=true;}
    expect(refused && visibleOnly(changed), "same-length viewport mutation refuses mixed snapshot");
    Provider bounded(L"HIDDEN!visibleHIDDEN!", 9,9);bounded.visibleSpans={{bounded.docStart+7,bounded.docEnd-7}};
    refused=false;try{capture(bounded,true,1);}catch(const std::exception&){refused=true;}
    expect(refused && visibleOnly(bounded), "budget refusal never falls back to whole document");
}
int main() {
    {
        const auto caption = std::wstring(990, L'x') + L" AKIA" + std::wstring(16, L'A') + L". Long caption. ";
        Provider p(caption, 0, 0);
        const auto source = UiaCaretSource::rangeSource(p.range(p.docStart, p.docEnd), GetTickCount64());
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
        expect(UiaCaretSource::rangeSource(p.range(p.docStart, p.docEnd), GetTickCount64()) == "Caption" && p.outsideReads == 0,
            "approved child caption never reads surrounding document source");
    }
    {
        Provider p(L"Visible. password: " + std::wstring(600000, L'x'), 0, 0); p.unitSize = 7;
        expect(UiaCaretSource::rangeSource(p.range(p.docStart, p.docEnd), GetTickCount64()) == "Visible. ",
            "oversize caption keeps closed prefix but withholds incomplete credential");
    }
    {
        Provider p(L"Caption", 0, 0); p.changeText = true;
        bool refused = false;
        try { (void)UiaCaretSource::rangeSource(p.range(p.docStart, p.docEnd), GetTickCount64()); }
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
        Provider expired(L"plain", 0, 5); bool timedOut = false;
        try { UiaCaretSource::read(&expired, GetTickCount64() - 1501); } catch (const std::exception&) { timedOut = true; }
        expect(timedOut && expired.reads == 0, "expired deadline prevents acquisition");
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
        viewportContracts();
        editContracts();
        std::cout << "UIA and Edit caret acquisition contracts passed\n";
        return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
