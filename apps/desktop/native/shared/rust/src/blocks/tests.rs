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

/// The walk the core decides, the helper's part done as a helper does it.
fn through_core(nodes: &[Node], low: isize, high: usize, elements: usize) -> Option<Vec<usize>> {
    let call = |input: Value| process(&input).unwrap();
    let mut reply = call(json!({"start": {"elements": elements}}));
    let mut path: Vec<usize> = Vec::new();
    let mut starts = std::collections::BTreeSet::new();
    let mut last: Option<usize> = None;
    loop {
        if reply["start"] == true {
            starts.insert(nodes[last.unwrap()].start);
        }
        if let Some(done) = reply.get("done") {
            return (done == true).then(|| starts.into_iter().collect());
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
            last = Some(child);
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

/// On many fields, windows and budgets, the core's walk gives the reference's starts, and the
/// same refusals past the budget.
#[test]
fn the_cores_walk_matches_the_reference_walk() {
    let mut seed = 7u64;
    let mut compared = (0, 0, 0);
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
            for elements in [0, 1, 3, 8, 500] {
                let expected = reference(&nodes, low, high, elements);
                assert_eq!(through_core(&nodes, low, high, elements), expected);
                match &expected {
                    None => compared.0 += 1,
                    Some(starts) if starts.is_empty() => compared.1 += 1,
                    Some(_) => compared.2 += 1,
                }
            }
        }
    }
    // Not vacuous: refusals, empty answers and starts all came up many times.
    assert!(
        compared.0 > 500 && compared.1 > 500 && compared.2 > 500,
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
    assert_eq!(through_core(&nodes, 0, 30, 100), Some(vec![5, 15, 25]));
    assert_eq!(through_core(&nodes, 16, 30, 100), Some(vec![25]));
    // Too few looks for the window: no starts at all, not some.
    assert_eq!(through_core(&nodes, 0, 30, 3), None);
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
