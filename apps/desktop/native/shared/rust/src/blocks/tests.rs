use super::*;

/// A field's elements: each one's place in the text (start, length), whether it is a block, and its
/// children in order.
#[derive(Clone)]
struct Node {
    start: usize,
    length: usize,
    block: bool,
    children: Vec<usize>,
}

/// The walk as the Mac's helper did it before the core decided it, offsets and all, kept here as
/// the reference the core's walk must match.
fn reference(nodes: &[Node], low: isize, high: usize, elements: usize) -> Option<Vec<usize>> {
    let mut starts = std::collections::BTreeSet::new();
    let mut looks = 0;
    fn walk(
        nodes: &[Node],
        node: usize,
        low: isize,
        high: usize,
        elements: usize,
        looks: &mut usize,
        starts: &mut std::collections::BTreeSet<usize>,
    ) -> bool {
        let children = &nodes[node].children;
        let place = |looks: &mut usize, child: usize| {
            *looks += 1;
            (*looks <= elements).then_some(&nodes[child])
        };
        let (mut lower, mut upper) = (0, children.len());
        while lower < upper {
            let middle = (lower + upper) / 2;
            let Some(span) = place(looks, children[middle]) else {
                return false;
            };
            if ((span.start + span.length) as isize) < low {
                lower = middle + 1;
            } else {
                upper = middle;
            }
        }
        let mut after_block = lower > 0 && nodes[children[lower - 1]].block;
        for &child in &children[lower..] {
            let Some(span) = place(looks, child) else {
                return false;
            };
            if span.start > high {
                break;
            }
            let block = span.block;
            if (block || after_block) && span.start as isize >= low {
                starts.insert(span.start);
            }
            if block && !walk(nodes, child, low, high, elements, looks, starts) {
                return false;
            }
            after_block = block;
        }
        true
    }
    walk(nodes, 0, low, high, elements, &mut looks, &mut starts)
        .then(|| starts.into_iter().collect())
}

/// What the walk gives: the window's starts, the reference's, when that walk ends within the
/// budget; else the selection's alone, walked on the smaller of the budget and its own.
fn expected(
    nodes: &[Node],
    selection: (isize, usize),
    window: (isize, usize),
    elements: usize,
) -> Option<Vec<usize>> {
    reference(nodes, window.0, window.1, elements).or_else(|| {
        reference(
            nodes,
            selection.0,
            selection.1,
            elements.min(SELECTION_ELEMENTS),
        )
    })
}

/// The walk the core decides, the helper's part done as a helper does it: each place's facts
/// compared with the ends of the window its ask names, each start kept with that window, and the
/// starts of the window the end names returned.
fn through_core(
    nodes: &[Node],
    selection: (isize, usize),
    window: (isize, usize),
    elements: usize,
) -> Option<Vec<usize>> {
    let call = |input: Value| process(&input).unwrap();
    let mut reply = call(json!({"start": {"elements": elements}}));
    let mut path: Vec<usize> = Vec::new();
    let mut starts: std::collections::BTreeMap<String, std::collections::BTreeSet<usize>> =
        Default::default();
    let mut last: Option<(usize, String)> = None;
    loop {
        if reply["start"] == true {
            let (child, placed) = last.clone().unwrap();
            starts.entry(placed).or_default().insert(nodes[child].start);
        }
        if let Some(done) = reply.get("done") {
            if done != true {
                assert!(reply.get("starts").is_none());
                return None;
            }
            let kept = reply["starts"].as_str().unwrap();
            assert!(kept == "shown" || kept == "caret");
            return Some(
                starts
                    .remove(kept)
                    .unwrap_or_default()
                    .into_iter()
                    .collect(),
            );
        }
        let state = reply["state"].clone();
        let ask = &reply["ask"];
        if let Some(asked) = ask.get("children") {
            let node = match &asked["depth"] {
                Value::Null => {
                    path.clear();
                    0
                }
                depth => {
                    path.truncate(depth.as_u64().unwrap() as usize + 1);
                    nodes[*path.last().unwrap()].children[asked["child"].as_u64().unwrap() as usize]
                }
            };
            path.push(node);
            reply = call(json!({"state": state, "children": nodes[node].children.len()}));
        } else {
            let asked = &ask["place"];
            path.truncate(asked["depth"].as_u64().unwrap() as usize + 1);
            let child =
                nodes[*path.last().unwrap()].children[asked["child"].as_u64().unwrap() as usize];
            let named = asked["window"].as_str().unwrap();
            let (low, high) = match named {
                "shown" => window,
                "caret" => selection,
                _ => panic!("{named}"),
            };
            last = Some((child, named.to_string()));
            let span = &nodes[child];
            // Only the facts the phase needs, as a helper sends them.
            let facts = if asked["phase"] == "halve" {
                json!({"block": span.block, "endsBefore": ((span.start + span.length) as isize) < low})
            } else {
                assert_eq!(asked["phase"], "scan");
                json!({"block": span.block, "startsPast": span.start > high,
                    "startsWithin": span.start as isize >= low})
            };
            reply = call(json!({"state": state, "placed": facts}));
        }
    }
}

/// A small random field: nested blocks and inline runs laid out in order, as Chromium's tree is.
fn field(seed: &mut u64) -> Vec<Node> {
    let mut next = || {
        *seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (*seed >> 33) as usize
    };
    let mut nodes = vec![Node {
        start: 0,
        length: 0,
        block: false,
        children: vec![],
    }];
    fn fill(
        nodes: &mut Vec<Node>,
        parent: usize,
        at: &mut usize,
        depth: usize,
        next: &mut dyn FnMut() -> usize,
    ) {
        let count = next() % 6;
        for _ in 0..count {
            // Text between elements (a space no element holds) leaves a gap.
            *at += next() % 3 / 2;
            let block = next().is_multiple_of(2);
            let id = nodes.len();
            let start = *at;
            nodes.push(Node {
                start,
                length: 0,
                block,
                children: vec![],
            });
            nodes[parent].children.push(id);
            if block && depth < 3 {
                fill(nodes, id, at, depth + 1, next);
            }
            *at += next() % 5 + usize::from(nodes[id].children.is_empty());
            nodes[id].length = *at - start;
        }
    }
    let mut at = 0;
    fill(&mut nodes, 0, &mut at, 0, &mut next);
    nodes[0].length = at;
    nodes
}

/// On many fields, selections, windows and budgets: where the reference walks the window within
/// the budget, the core gives exactly its starts; elsewhere the selection's, or none.
#[test]
fn the_cores_walk_matches_the_reference_walk() {
    let mut seed = 7u64;
    // Windows walked whole; selections' starts kept; refusals; and of the kept, some starts.
    let mut compared = (0, 0, 0, 0);
    for _ in 0..1_500 {
        let nodes = field(&mut seed);
        let total = nodes[0].length;
        for (low, high) in [
            (-3, total + 3),
            (2, 6),
            (5, 5),
            (0, 0),
            (total as isize, total),
        ] {
            let middle = (low.max(0) as usize + high) / 2;
            for selection in [
                (middle as isize, middle),
                (low.max(0), high),
                (low.max(0), low.max(0) as usize),
            ] {
                for elements in [0, 1, 3, 8, 20, 500] {
                    let got = through_core(&nodes, selection, (low, high), elements);
                    // A window walked whole within the budget gives what it gave before.
                    if let Some(whole) = reference(&nodes, low, high, elements) {
                        assert_eq!(got, Some(whole));
                        compared.0 += 1;
                    } else {
                        assert_eq!(got, expected(&nodes, selection, (low, high), elements));
                        match &got {
                            None => compared.2 += 1,
                            Some(starts) => {
                                compared.1 += 1;
                                compared.3 += usize::from(!starts.is_empty());
                            }
                        }
                    }
                }
            }
        }
    }
    // Not vacuous: each way the walk ends came up many times.
    assert!(
        compared.0 > 500 && compared.1 > 500 && compared.2 > 500 && compared.3 > 100,
        "{compared:?}"
    );
}

/// A Gmail-shaped field: text, then two paragraphs. Each paragraph starts a line, and so does the
/// text after the last one; only the elements the window needs are placed.
#[test]
fn a_rich_editors_blocks_start_lines() {
    let nodes = vec![
        Node {
            start: 0,
            length: 30,
            block: false,
            children: vec![1, 2, 3, 4],
        },
        Node {
            start: 0,
            length: 5,
            block: false,
            children: vec![],
        },
        Node {
            start: 5,
            length: 10,
            block: true,
            children: vec![],
        },
        Node {
            start: 15,
            length: 10,
            block: true,
            children: vec![],
        },
        Node {
            start: 25,
            length: 5,
            block: false,
            children: vec![],
        },
    ];
    let caret = (15, 15);
    assert_eq!(
        through_core(&nodes, caret, (0, 30), 100),
        Some(vec![5, 15, 25])
    );
    assert_eq!(
        through_core(&nodes, (20, 20), (16, 30), 100),
        Some(vec![25])
    );
    // The window takes seven looks: three halving, four placing. Within them, all its starts.
    assert_eq!(
        through_core(&nodes, caret, (0, 30), 7),
        Some(vec![5, 15, 25])
    );
    // Fewer: the selection's walk (three halving, three placing) gives the caret's start alone.
    assert_eq!(through_core(&nodes, caret, (0, 30), 6), Some(vec![15]));
    // Too few looks for the selection too: no starts at all, not some.
    assert_eq!(through_core(&nodes, caret, (0, 30), 5), None);
}

/// Lines of `pieces` inline elements `width` long each, every line a block of the field.
fn editor(lines: usize, pieces: usize, width: usize) -> Vec<Node> {
    let mut nodes = vec![Node {
        start: 0,
        length: lines * pieces * width,
        block: false,
        children: vec![],
    }];
    for line in 0..lines {
        let id = nodes.len();
        nodes[0].children.push(id);
        nodes.push(Node {
            start: line * pieces * width,
            length: pieces * width,
            block: true,
            children: vec![],
        });
        for piece in 0..pieces {
            let child = nodes.len();
            nodes[id].children.push(child);
            nodes.push(Node {
                start: line * pieces * width + piece * width,
                length: width,
                block: false,
                children: vec![],
            });
        }
    }
    nodes
}

/// A code editor whose window holds more elements than the budget (each highlighted piece of a
/// line its own, as Overleaf's in Firefox): the caret starting a line still gets its start.
#[test]
fn a_dense_editor_keeps_the_start_at_the_caret_past_the_budget() {
    let (lines, pieces, width) = (40, 16, 5);
    let nodes = editor(lines, pieces, width);
    let caret = 25 * pieces * width;
    let window = (caret as isize - 4000, caret + 4000);
    // The window needs every element: past the budget, as in the editor.
    assert_eq!(reference(&nodes, window.0, window.1, 300), None);
    assert_eq!(
        through_core(&nodes, (caret as isize, caret), window, 300),
        Some(vec![caret])
    );
    // Inside a line, the caret's place has no start.
    assert_eq!(
        through_core(&nodes, (caret as isize + 7, caret + 7), window, 300),
        Some(vec![])
    );
    // A selection over more lines than its own budget holds: no starts, as before.
    assert_eq!(
        through_core(&nodes, (0, lines * pieces * width), window, 300),
        None
    );
    // With budget enough for the window, every line's start.
    assert_eq!(
        through_core(&nodes, (caret as isize, caret), window, 1000),
        Some((0..lines).map(|line| line * pieces * width).collect())
    );
}

/// A window the budget holds keeps all its starts, however few looks are left over: walking the
/// selection first would spend some of them (290 lines walked in 299 looks of 300).
#[test]
fn a_window_the_budget_holds_keeps_all_its_starts() {
    let lines = 290;
    let mut nodes = editor(lines, 1, 5);
    // Lines with no elements of their own: one look each.
    for node in nodes.iter_mut().filter(|node| node.block) {
        node.children.clear();
    }
    let caret = 1000;
    let window = (caret as isize - 4000, caret + 4000);
    let all: Vec<usize> = (0..lines).map(|line| line * 5).collect();
    assert_eq!(
        reference(&nodes, window.0, window.1, 300),
        Some(all.clone())
    );
    assert_eq!(reference(&nodes, window.0, window.1, 298), None);
    assert_eq!(
        through_core(&nodes, (caret as isize, caret), window, 300),
        Some(all)
    );
}

/// The walk places by the window first, then, when that walk runs out of budget, by the selection
/// on a budget of its own; each ask names its window, and the end names whose starts to keep. An
/// element with no place ends either walk with no starts.
#[test]
fn the_walk_places_by_the_window_then_by_the_selection() {
    let start = process(&json!({"start": {"elements": 1000}})).unwrap();
    assert_eq!(start["state"]["window"], "shown");
    let one = process(&json!({"state": start["state"], "children": 1})).unwrap();
    assert_eq!(one["ask"]["place"]["window"], "shown");
    // An element with no place ends the window's walk with no starts: the OS misplaced something.
    assert_eq!(
        process(&json!({"state": one["state"], "placed": null})).unwrap(),
        json!({"done": false, "start": false})
    );
    // Running out of budget begins the selection's walk from the field, on a budget of its own.
    let mut spent = one["state"].clone();
    spent["looks"] = spent["elements"].clone();
    let again =
        process(&json!({"state": spent, "placed": {"block": false, "endsBefore": false}})).unwrap();
    assert_eq!(again["ask"]["children"], json!({"depth": null, "child": 0}));
    assert_eq!(again["state"]["window"], "caret");
    assert_eq!(again["state"]["looks"], 0);
    assert_eq!(again["state"]["elements"], SELECTION_ELEMENTS);
    let two = process(&json!({"state": again["state"], "children": 1})).unwrap();
    assert_eq!(two["ask"]["place"]["window"], "caret");
    // And an element with no place in the selection's: no starts either.
    assert_eq!(
        process(&json!({"state": two["state"], "placed": null})).unwrap(),
        json!({"done": false, "start": false})
    );
    // The selection's walk ending names its starts.
    let past =
        process(&json!({"state": two["state"], "placed": {"block": false, "endsBefore": false}}))
            .unwrap();
    assert_eq!(
        process(&json!({"state": past["state"], "placed":
            {"block": false, "startsPast": true, "startsWithin": true}}))
        .unwrap(),
        json!({"done": true, "starts": "caret", "start": false})
    );
    // The window's walk ending names its own.
    let past =
        process(&json!({"state": one["state"], "placed": {"block": false, "endsBefore": false}}))
            .unwrap();
    assert_eq!(
        process(&json!({"state": past["state"], "placed":
            {"block": false, "startsPast": true, "startsWithin": true}}))
        .unwrap(),
        json!({"done": true, "starts": "shown", "start": false})
    );
    // The window's walk running out with a start just placed: the reply that begins the
    // selection's carries that start, which the window's ask placed.
    let tight = process(&json!({"start": {"elements": 4}})).unwrap();
    let three = process(&json!({"state": tight["state"], "children": 3})).unwrap();
    let halved =
        process(&json!({"state": three["state"], "placed": {"block": false, "endsBefore": false}}))
            .unwrap();
    let first =
        process(&json!({"state": halved["state"], "placed": {"block": true, "endsBefore": false}}))
            .unwrap();
    let block = process(&json!({"state": first["state"], "placed":
        {"block": true, "startsPast": false, "startsWithin": true}}))
    .unwrap();
    assert_eq!(block["start"], true);
    let after = process(&json!({"state": block["state"], "children": 0})).unwrap();
    assert_eq!(
        after["ask"]["place"],
        json!({"depth": 0, "child": 1, "phase": "scan", "window": "shown"})
    );
    let out = process(&json!({"state": after["state"], "placed":
        {"block": false, "startsPast": false, "startsWithin": true}}))
    .unwrap();
    assert_eq!(out["start"], true);
    assert_eq!(out["ask"]["children"], json!({"depth": null, "child": 0}));
    // A small budget stays as small in the selection's walk.
    assert_eq!(out["state"]["window"], "caret");
    assert_eq!(out["state"]["elements"], 4);
    let mut nameless = out["state"].clone();
    nameless["window"] = json!("page");
    assert_eq!(process(&json!({"state": nameless, "children": 1})), Err(1));
    nameless.as_object_mut().unwrap().remove("window");
    assert_eq!(process(&json!({"state": nameless, "children": 1})), Err(1));
}

#[test]
fn a_line_ends_where_the_selections_element_runs_up_to_it() {
    let ends = |before: bool, reaches: bool| {
        process(&json!({"endsLine": {"startsBefore": before, "reachesSelection": reaches}}))
            .unwrap()["endsLine"]
            .clone()
    };
    assert_eq!(ends(true, true), true);
    assert_eq!(ends(false, true), false);
    assert_eq!(ends(true, false), false);
}

/// A collapsed caret the screen draws away from the character before it (Gecko's on an empty line
/// on the Mac, its marker in the line above's element) starts its line; one drawn right after that
/// character ends it. Rectangles as measured in Overleaf's code editor in Firefox, 2026-11-05.
#[test]
fn a_caret_drawn_away_from_the_text_before_it_starts_its_line() {
    let rect = |x: f64, y: f64, width: f64, height: f64| json!({"x": x, "y": y, "width": width, "height": height});
    let period = rect(1224.0, 100.0, 12.0, 25.0);
    let ends = |before: bool, reaches: bool, caret: Option<Value>, previous: Option<Value>| {
        let mut facts = json!({"startsBefore": before, "reachesSelection": reaches});
        if let Some(caret) = caret {
            facts["caret"] = caret;
        }
        if let Some(previous) = previous {
            facts["before"] = previous;
        }
        process(&json!({"endsLine": facts})).map(|reply| reply["endsLine"].clone())
    };
    let drawn = |caret: Value| ends(true, true, Some(caret), Some(period.clone()));
    // Right after the period: the end of its line. At the editor's left edge: an empty line's start.
    assert_eq!(drawn(rect(1236.0, 100.0, 1.0, 25.0)), Ok(json!(true)));
    assert_eq!(drawn(rect(888.0, 100.0, 1.0, 31.5)), Ok(json!(false)));
    // The character's middle is the line between the two; a caret on the row below starts its line.
    assert_eq!(drawn(rect(1230.0, 100.0, 1.0, 25.0)), Ok(json!(true)));
    assert_eq!(drawn(rect(1229.5, 100.0, 1.0, 25.0)), Ok(json!(false)));
    assert_eq!(drawn(rect(1236.0, 124.5, 1.0, 25.0)), Ok(json!(true)));
    assert_eq!(drawn(rect(1236.0, 125.0, 1.0, 25.0)), Ok(json!(false)));
    // The screen only takes a line end away: an element that starts no line still starts none.
    assert_eq!(
        ends(
            false,
            true,
            Some(rect(1236.0, 100.0, 1.0, 25.0)),
            Some(period.clone())
        ),
        Ok(json!(false))
    );
    assert_eq!(
        ends(
            true,
            false,
            Some(rect(1236.0, 100.0, 1.0, 25.0)),
            Some(period.clone())
        ),
        Ok(json!(false))
    );
    // Without both rectangles, or with one of no height, the element decides alone.
    let away = rect(888.0, 100.0, 1.0, 31.5);
    assert_eq!(ends(true, true, Some(away.clone()), None), Ok(json!(true)));
    assert_eq!(
        ends(true, true, None, Some(period.clone())),
        Ok(json!(true))
    );
    assert_eq!(
        ends(
            true,
            true,
            Some(rect(888.0, 100.0, 1.0, 0.0)),
            Some(period.clone())
        ),
        Ok(json!(true))
    );
    assert_eq!(
        ends(
            true,
            true,
            Some(away.clone()),
            Some(rect(1224.0, 100.0, 12.0, 0.0))
        ),
        Ok(json!(true))
    );
    // Nor with one of negative height: no place on screen either.
    assert_eq!(
        ends(
            true,
            true,
            Some(rect(888.0, 100.0, 1.0, -31.5)),
            Some(period.clone())
        ),
        Ok(json!(true))
    );
    assert_eq!(
        ends(
            true,
            true,
            Some(away.clone()),
            Some(rect(1224.0, 100.0, 12.0, -25.0))
        ),
        Ok(json!(true))
    );
    // A rectangle that is not one is refused, even beside one of no height.
    assert_eq!(
        ends(
            true,
            true,
            Some(json!({"x": "888", "y": 100, "width": 1, "height": 25})),
            Some(period.clone())
        ),
        Err(1)
    );
    assert_eq!(
        ends(
            true,
            true,
            Some(json!({"x": 888, "y": 100, "width": 1})),
            Some(period.clone())
        ),
        Err(1)
    );
    assert_eq!(
        ends(
            true,
            true,
            Some(json!({"x": 888, "y": "100", "width": 1, "height": 25})),
            Some(period.clone())
        ),
        Err(1)
    );
    assert_eq!(
        ends(
            true,
            true,
            Some(away.clone()),
            Some(json!({"x": 1224, "y": 100, "height": 25}))
        ),
        Err(1)
    );
    assert_eq!(
        ends(
            true,
            true,
            Some(rect(888.0, 100.0, 1.0, 0.0)),
            Some(json!(true))
        ),
        Err(1)
    );
}

/// A reply to anything but what was asked, or a state no walk gives, is refused.
#[test]
fn answers_out_of_turn_are_refused() {
    let start = process(&json!({"start": {"elements": 5}})).unwrap();
    let state = start["state"].clone();
    assert_eq!(
        process(
            &json!({"state": state, "placed": {"block": true, "endsBefore": false, "startsPast": false, "startsWithin": true}})
        ),
        Err(1)
    );
    let children = process(&json!({"state": state, "children": 2})).unwrap();
    assert_eq!(children["ask"]["place"]["child"], 1);
    assert_eq!(
        process(&json!({"state": children["state"], "children": 2})),
        Err(1)
    );
    let mut forged = children["state"].clone();
    forged["asked"]["child"] = json!(0);
    assert_eq!(
        process(&json!({"state": forged, "placed": {"block": false, "endsBefore": true}})),
        Err(1)
    );
    let mut forged = children["state"].clone();
    forged["looks"] = json!(6);
    assert_eq!(process(&json!({"state": forged, "placed": null})), Err(1));
    let mut forged = children["state"].clone();
    forged["stack"][0]["lower"] = json!(3);
    assert_eq!(process(&json!({"state": forged, "placed": null})), Err(1));
    // A halving past its element's children, a walk deeper than its elements, and a place sent
    // while the element's children were asked for.
    let mut forged = children["state"].clone();
    forged["stack"][0]["upper"] = json!(3);
    assert_eq!(
        process(&json!({"state": forged, "placed": {"block": false, "endsBefore": true}})),
        Err(1)
    );
    let mut forged = children["state"].clone();
    forged["stack"] = json!(vec![children["state"]["stack"][0].clone(); 7]);
    assert_eq!(
        process(&json!({"state": forged, "placed": {"block": false, "endsBefore": true}})),
        Err(1)
    );
    let mut forged = children["state"].clone();
    forged["asked"]["children"] = json!(true);
    assert_eq!(
        process(&json!({"state": forged, "placed": {"block": false, "endsBefore": true}})),
        Err(1)
    );
    // A place for another child than the one asked for, once the halving is done.
    let one = process(&json!({"state": start["state"], "children": 1})).unwrap();
    let scan =
        process(&json!({"state": one["state"], "placed": {"block": false, "endsBefore": false}}))
            .unwrap();
    assert_eq!(scan["ask"]["place"]["child"], 0);
    let mut forged = scan["state"].clone();
    forged["asked"]["child"] = json!(1);
    assert_eq!(
        process(
            &json!({"state": forged, "placed": {"block": false, "endsBefore": false, "startsPast": false, "startsWithin": true}})
        ),
        Err(1)
    );
    // A scan past its element's children.
    let mut forged = scan["state"].clone();
    forged["stack"][0]["scan"] = json!(2);
    forged["asked"]["child"] = json!(2);
    assert_eq!(
        process(
            &json!({"state": forged, "placed": {"block": false, "endsBefore": false, "startsPast": false, "startsWithin": true}})
        ),
        Err(1)
    );
    // An element with no place ends the walk with no starts.
    assert_eq!(
        process(&json!({"state": children["state"], "placed": null})).unwrap(),
        json!({"done": false, "start": false})
    );
    assert_eq!(
        process(&json!({"state": children["state"], "placed": {}})),
        Err(1)
    );
    assert_eq!(
        process(&json!({"start": {"elements": 1}, "children": 1})),
        Err(1)
    );
    assert_eq!(process(&json!({"state": children["state"]})), Err(1));
}

/// A Gecko caret over its own line and the one above takes the line drawn at its bottom; one on a
/// single line keeps its place. Rectangles as measured in Firefox's CodeMirror page on Windows,
/// 2026-11-08 (#380): a line's start, an empty line, a line's middle, and the compose page's
/// empty line, whose caret is shorter than the line drawn there.
#[test]
fn a_caret_over_two_lines_is_on_the_one_at_its_bottom() {
    let rect = |x: f64, y: f64, width: f64, height: f64| json!({"x": x, "y": y, "width": width, "height": height});
    let line = |caret: Value, drawn: Option<Value>| {
        let mut facts = json!({"caret": caret});
        if let Some(drawn) = drawn {
            facts["drawn"] = drawn;
        }
        process(&json!({"caretLine": facts})).map(|reply| reply["caretLine"].clone())
    };
    // A line's start: the caret covers line 12 (286) and its own (306); the character there is 17 high.
    assert_eq!(
        line(
            rect(30.0, 286.0, 1.0, 37.0),
            Some(rect(30.0, 306.0, 8.0, 17.0))
        ),
        Ok(rect(30.0, 306.0, 1.0, 17.0))
    );
    // Only the height and top move: a wider caret keeps its own x and width, whatever the character's.
    assert_eq!(
        line(
            rect(30.0, 286.0, 2.0, 37.0),
            Some(rect(22.0, 306.0, 8.0, 17.0))
        ),
        Ok(rect(30.0, 306.0, 2.0, 17.0))
    );
    // An empty line: the place drawn there is a little taller than a line of text.
    assert_eq!(
        line(
            rect(30.0, 326.0, 1.0, 36.0),
            Some(rect(30.0, 344.0, 1.0, 19.0))
        ),
        Ok(rect(30.0, 344.0, 1.0, 19.0))
    );
    // On one line: the character is as high as the caret, or taller, and starts at its top.
    let middle = rect(184.0, 306.0, 1.0, 17.0);
    assert_eq!(
        line(middle.clone(), Some(rect(184.0, 306.0, 8.0, 17.0))),
        Ok(middle.clone())
    );
    let compose = rect(16.0, 353.0, 1.0, 18.0);
    assert_eq!(
        line(compose.clone(), Some(rect(16.0, 353.0, 1.0, 20.0))),
        Ok(compose.clone())
    );
    // Text a little shorter than its caret, a few pixels below its top, is the caret's own line.
    let tall = rect(100.0, 200.0, 1.0, 20.0);
    assert_eq!(
        line(tall.clone(), Some(rect(100.0, 202.0, 8.0, 16.0))),
        Ok(tall.clone())
    );
    // The line above must have room: from half the drawn line's height below the caret's top.
    assert_eq!(
        line(tall.clone(), Some(rect(100.0, 205.0, 8.0, 10.0))),
        Ok(rect(100.0, 205.0, 1.0, 10.0))
    );
    assert_eq!(
        line(tall.clone(), Some(rect(100.0, 204.9, 8.0, 10.0))),
        Ok(tall.clone())
    );
    // Drawn below the caret, or as tall as it: not the caret's line.
    assert_eq!(
        line(tall.clone(), Some(rect(100.0, 220.0, 8.0, 10.0))),
        Ok(tall.clone())
    );
    assert_eq!(
        line(tall.clone(), Some(rect(100.0, 210.0, 8.0, 20.0))),
        Ok(tall.clone())
    );
    // Nothing drawn there, or nothing with a height: the caret stays.
    assert_eq!(line(tall.clone(), None), Ok(tall.clone()));
    assert_eq!(
        line(tall.clone(), Some(rect(100.0, 210.0, 8.0, 0.0))),
        Ok(tall.clone())
    );
    // A caret is required, with a place; nothing else may come with the ask.
    assert_eq!(process(&json!({"caretLine": {}})), Err(1));
    assert_eq!(
        process(&json!({"caretLine": {"caret": rect(1.0, 1.0, 1.0, 0.0)}})),
        Err(1)
    );
    assert_eq!(
        process(&json!({"caretLine": {"caret": tall.clone()}, "start": {"elements": 1}})),
        Err(1)
    );
    assert_eq!(
        process(&json!({"caretLine": {"caret": tall.clone()}, "state": "x"})),
        Err(1)
    );
    // Every place is four numbers.
    assert_eq!(
        line(json!({"x": 100.0, "y": "200", "width": 1.0, "height": 20.0}), None),
        Err(1)
    );
    assert_eq!(
        line(
            tall.clone(),
            Some(json!({"x": 100.0, "y": 205.0, "width": 8.0, "height": "10"}))
        ),
        Err(1)
    );
}
