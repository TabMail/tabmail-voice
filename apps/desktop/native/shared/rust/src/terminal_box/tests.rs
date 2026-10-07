use super::*;
use serde_json::json;

/// A viewport projection's output holding `rows` as one run of surface 1, the caret `offset` UTF-16
/// units into it.
fn projected(rows: &[&str], offset: usize) -> Value {
    json!({"caret": {"status": "exact", "surface": 1, "run": 0, "offset": offset},
        "surfaces": [{"id": 1, "runs": [{"id": 0, "text": rows.join("\n"), "connected": false}]}]})
}

/// The box around the caret at the first `‸` in `rows`.
fn boxed(rows: &[&str]) -> Option<CaretBox> {
    let text = rows.join("\n");
    let at = text.find('‸').unwrap();
    let offset = text[..at].encode_utf16().count();
    let without: Vec<String> = rows.iter().map(|row| row.replacen('‸', "", 1)).collect();
    let without: Vec<&str> = without.iter().map(String::as_str).collect();
    caret_box(&projected(&without, offset))
}

fn caret(above: &[&str], before: &str, after: &str, below: &[&str]) -> Option<CaretBox> {
    Some(CaretBox {
        above: above.iter().map(|row| (*row).to_owned()).collect(),
        before: before.to_owned(),
        after: after.to_owned(),
        below: below.iter().map(|row| (*row).to_owned()).collect(),
    })
}

/// A plain shell has no borders: every row in view is in the box.
#[test]
fn a_shell_without_borders_is_one_box() {
    assert_eq!(
        boxed(&["$ ls", "notes.txt", "$ git commit -m \"Note:‸"]),
        caret(&["$ ls", "notes.txt"], "$ git commit -m \"Note:", "", &[])
    );
}

/// tmux draws the panes of a row side by side: the cursor's pane is cut at their border, on its row
/// and the rows above, and a pane to its left never reaches the text before the cursor.
#[test]
fn a_tmux_pane_is_cut_at_its_borders() {
    let rows = [
        "build ok.          │ $ echo one",
        "Done.              │ one",
        "tests passed:      │ Note:‸",
        "                   │",
    ];
    assert_eq!(
        boxed(&rows),
        caret(&[" $ echo one", " one"], " Note:", "", &[""])
    );
    // The cursor in the left pane: the border is on its right.
    let rows = [
        "left one   │ right",
        "Note:‸      │ more",
        "           │ end",
    ];
    assert_eq!(boxed(&rows), caret(&["left one"], "Note:", "", &[""]));
}

/// A rule ends the box: tmux's border between panes one above the other, and the rules a full-screen
/// program such as Claude Code draws above and below its input.
#[test]
fn a_rule_ends_the_box() {
    let rows = [
        "✻ Working… (3s)",
        "────────────────────",
        "> fix the Xyvora",
        "  build‸",
        "────────────────────",
        "  ? for shortcuts",
    ];
    assert_eq!(
        boxed(&rows),
        caret(&["> fix the Xyvora"], "  build", "", &[])
    );
    // A pane under a horizontal tmux border, beside another.
    let rows = [
        "top        │ top right",
        "───────────┼──────────",
        "bottom     │ $ ok‸",
        "more       │",
    ];
    assert_eq!(boxed(&rows), caret(&[], " $ ok", "", &[""]));
}

/// The sides a program draws around its input are the box's borders, inside a tmux pane's.
#[test]
fn an_input_box_inside_a_pane_is_the_innermost_box() {
    let rows = [
        "log line     │ ╭──────────╮",
        "log Note:    │ │ > Hi.‸    │",
        "log end      │ ╰──────────╯",
    ];
    assert_eq!(boxed(&rows), caret(&[], " > Hi.", "", &[]));
}

/// The text after the cursor runs to the border, its trailing blanks dropped; a space typed before
/// the cursor stays.
#[test]
fn the_cursor_row_keeps_what_was_typed_before_the_cursor() {
    assert_eq!(
        boxed(&["Done. ‸Next   "]),
        caret(&[], "Done. ", "Next", &[])
    );
    assert_eq!(
        boxed(&["a\r", "b‸c\r", "d\r"]),
        caret(&["a"], "b", "c", &["d"])
    );
    // A caret at the end of a CRLF row: the carriage return is not text typed before it.
    assert_eq!(boxed(&["a\r", "b\r‸", "c"]), caret(&["a"], "b", "", &["c"]));
}

/// A border right beside the cursor is its box's border: the box starts after one just before the
/// cursor and ends at one just after it.
#[test]
fn a_border_beside_the_cursor_bounds_its_box() {
    assert_eq!(boxed(&["left │‸x │ right"]), caret(&[], "", "x", &[]));
    assert_eq!(boxed(&["left │ x‸│ right"]), caret(&[], " x", "", &[]));
}

/// Only an exact caret gets a box; one the runs do not hold, or inside a character, gets none.
#[test]
fn a_caret_not_placed_exactly_gets_no_box() {
    let mut value = projected(&["Note:"], 5);
    value["caret"] = json!({"status": "outsideViewport"});
    assert_eq!(caret_box(&value), None);
    let mut value = projected(&["Note:"], 5);
    value["caret"]["run"] = json!(7);
    assert_eq!(caret_box(&value), None);
    assert_eq!(caret_box(&projected(&["Note:"], 6)), None);
    assert_eq!(caret_box(&projected(&["😀"], 1)), None);
}

/// Runs read in one piece with the caret's are one text: the row the caret is on can start in the
/// run before.
#[test]
fn connected_runs_are_read_as_one_text() {
    let value = json!({"caret": {"status": "exact", "surface": 1, "run": 1, "offset": 3},
        "surfaces": [{"id": 1, "runs": [
            {"id": 0, "text": "gap", "connected": false},
            {"id": 5, "text": "> Note", "connected": false},
            {"id": 1, "text": ": hi", "connected": true}]}]});
    assert_eq!(caret_box(&value), caret(&[], "> Note: h", "i", &[]));
}

/// A row that does not have the cursor's borders where the cursor's row has them ends the box:
/// tmux's status line under its panes, and a row too short to reach the border.
#[test]
fn a_row_without_the_cursors_borders_ends_the_box() {
    let rows = [
        "build ok.  │ $ echo one",
        "Done.      │ $ Note:‸",
        "[0] 0:zsh*  \"host\" 12:00",
    ];
    assert_eq!(boxed(&rows), caret(&[" $ echo one"], " $ Note:", "", &[]));
    let rows = ["left one   │ right", "Note:‸      │ more", "[0] 0:zsh"];
    assert_eq!(boxed(&rows), caret(&["left one"], "Note:", "", &[]));
    let rows = ["log", "left one   │ right", "Note:‸      │ more"];
    assert_eq!(boxed(&rows), caret(&["left one"], "Note:", "", &[]));
}

/// A rule may be drawn with gaps: a row of box-drawing characters and blanks only ends the box too.
#[test]
fn a_dashed_rule_ends_the_box() {
    let rows = ["> fix it‸", "─ ─ ─ ─ ─ ─", "  ? for shortcuts"];
    assert_eq!(boxed(&rows), caret(&[], "> fix it", "", &[]));
}

/// Only Unicode's box-drawing block borders a box: its last character does, an ASCII bar or a block
/// element just past it does not.
#[test]
fn only_box_drawing_characters_are_borders() {
    assert_eq!(boxed(&["a ╿ Note:‸"]), caret(&[], " Note:", "", &[]));
    assert_eq!(boxed(&["a | Note:‸"]), caret(&[], "a | Note:", "", &[]));
    assert_eq!(boxed(&["a ▀ Note:‸"]), caret(&[], "a ▀ Note:", "", &[]));
    assert_eq!(boxed(&["a ─ Note:‸"]), caret(&[], " Note:", "", &[]));
}

/// The runs read in one piece after the caret's are part of its text: the row goes on into the
/// next run, and so do the rows below it.
#[test]
fn a_connected_run_after_the_carets_continues_its_row() {
    let value = json!({"caret": {"status": "exact", "surface": 1, "run": 1, "offset": 4},
        "surfaces": [{"id": 1, "runs": [
            {"id": 1, "text": "> No", "connected": false},
            {"id": 2, "text": "te: hi\nnext", "connected": true},
            {"id": 3, "text": "other pane", "connected": false}]}]});
    assert_eq!(caret_box(&value), caret(&[], "> No", "te: hi", &["next"]));
}

/// A double-width character (CJK, an emoji) takes two columns on screen: rows holding them, in the
/// cursor's pane or the pane beside it, still have their borders under the cursor's.
#[test]
fn double_width_characters_take_two_columns() {
    // The left pane's rows hold CJK and an emoji; each border is at column 13.
    let rows = [
        "日本語 build │ $ echo 你好",
        "👍 done.     │ 你好",
        "tests:       │ $ Note:‸",
    ];
    assert_eq!(
        boxed(&rows),
        caret(&[" $ echo 你好", " 你好"], " $ Note:", "", &[])
    );
    // The cursor in the left pane, after CJK, its border on the right.
    let rows = [
        "左 one     │ right",
        "日本語 x‸   │ more",
        "ok         │ end",
    ];
    assert_eq!(boxed(&rows), caret(&["左 one"], "日本語 x", "", &["ok"]));
    // A program's input box around a CJK line.
    let rows = ["╭──────────╮", "│ > 你好‸   │", "╰──────────╯"];
    assert_eq!(boxed(&rows), caret(&[], " > 你好", "", &[]));
}
