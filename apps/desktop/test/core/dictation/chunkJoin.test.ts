// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import * as config from "../../../src/core/config.js";
import { type ChunkText, joinChunkTexts } from "../../../src/core/dictation/chunkJoin.js";

const paused = (text: string): ChunkText => ({ text, overlapped: false });
const overlapping = (text: string): ChunkText => ({ text, overlapped: true });

describe("joinChunkTexts", () => {
  test("one chunk is its own text, untouched but for the whitespace around it", () => {
    expect(joinChunkTexts([paused("  Hello there... and then.  ")])).toBe("Hello there... and then.");
    expect(joinChunkTexts([])).toBe("");
  });

  test("chunks cut at a pause are joined with a space, nothing else changed", () => {
    expect(joinChunkTexts([paused("First part."), paused("Second part,"), paused("and the Third.")])).toBe("First part. Second part, and the Third.");
  });

  test("an ellipsis where two chunks meet is the cut's pause and is taken out; one inside a chunk stays", () => {
    expect(joinChunkTexts([paused("So I was thinking…"), paused("… that we could wait... maybe."), paused("...Or not")])).toBe("So I was thinking that we could wait... maybe. Or not");
    expect(joinChunkTexts([paused("Ends here ... …"), paused("next")])).toBe("Ends here next");
  });

  test("an ellipsis at the very start or end of the whole dictation stays", () => {
    expect(joinChunkTexts([paused("…well"), paused("then...")])).toBe("…well then...");
  });

  test("an empty or ellipsis-only chunk adds nothing and leaves no double space", () => {
    expect(joinChunkTexts([paused("One."), paused("   "), paused("…"), paused("Two.")])).toBe("One. Two.");
    expect(joinChunkTexts([paused(""), paused("Only this.")])).toBe("Only this.");
  });

  test("scripts written without spaces are joined without one", () => {
    expect(joinChunkTexts([paused("今日は会議があります。"), paused("明日は休みです。")])).toBe("今日は会議があります。明日は休みです。");
    expect(joinChunkTexts([paused("我们明天见"), paused("好的")])).toBe("我们明天见好的");
    expect(joinChunkTexts([paused("สวัสดีครับ"), paused("ขอบคุณครับ")])).toBe("สวัสดีครับขอบคุณครับ");
    expect(joinChunkTexts([paused("Meeting at 3."), paused("会議です")])).toBe("Meeting at 3.会議です");
    expect(joinChunkTexts([paused("안녕하세요."), paused("반갑습니다.")])).toBe("안녕하세요. 반갑습니다.");
  });

  test("overlapping chunks are joined where their words run together, the shared words kept once", () => {
    const left = "We should ship the release on Friday because the tests are gre";
    const right = "release on Friday because the tests are green and the notes are ready.";
    expect(joinChunkTexts([paused(left), overlapping(right)])).toBe("We should ship the release on Friday because the tests are green and the notes are ready.");
  });

  test("the overlap match ignores the capitals and punctuation a cut changes", () => {
    const left = "Then we talked about the budget, and the plan for. Next";
    const right = "About the budget and the plan for next quarter.";
    expect(joinChunkTexts([paused(left), overlapping(right)])).toBe("Then we talked about the budget and the plan for next quarter.");
    // The only run of three words or more is the same only ignoring case.
    expect(joinChunkTexts([paused("we met the Team Lead on Monday"), overlapping("The team lead on Monday said yes.")])).toBe("we met the team lead on Monday said yes.");
  });

  /** A later chunk's text starts with a capital, as any text does, though its first words are
   * mid-sentence: the shared run starts as the earlier chunk wrote it (owner, 2026-10-03:
   * "capitalization mid breaks"), and a name keeps its capital, as both wrote it. */
  test("an overlap join keeps the earlier text's case where the later one starts", () => {
    const left = "I want to read something long again so that you can test the forced";
    const right = "Something long again so that you can test the forced cuts and how well it does.";
    expect(joinChunkTexts([paused(left), overlapping(right)])).toBe("I want to read something long again so that you can test the forced cuts and how well it does.");
    expect(joinChunkTexts([paused("we asked Robin about the budget for next"), overlapping("Robin about the budget for next quarter.")])).toBe("we asked Robin about the budget for next quarter.");
  });

  test("overlapping chunks with no shared run are joined whole: words may repeat, none are lost", () => {
    const joined = joinChunkTexts([paused("Alpha beta gamma delta"), overlapping("delta epsilon zeta")]);
    expect(joined).toBe("Alpha beta gamma delta delta epsilon zeta");
    // A run shorter than `chunkOverlapMinimumRun` words is not trusted.
    const short = Array.from({ length: config.chunkOverlapMinimumRun - 1 }, (_, i) => `w${i}`).join(" ");
    expect(joinChunkTexts([paused(`one two ${short}`), overlapping(`${short} three`)])).toBe(`one two ${short} ${short} three`);
  });

  test("an overlap join keeps the earlier text's line breaks", () => {
    const left = "Dear team,\n\nThe launch moved to next week because the build is late";
    const right = "because the build is late and QA needs two more days.";
    expect(joinChunkTexts([paused(left), overlapping(right)])).toBe("Dear team,\n\nThe launch moved to next week because the build is late and QA needs two more days.");
  });

  /** A forced cut comes after about 105 s of speech, so the earlier text is far longer than the
   * window searched for the overlap: the words before the window are all kept. */
  test("an overlap join keeps all of a long earlier text, before the window searched", () => {
    const filler = Array.from({ length: config.chunkOverlapSearchWords * 2 + 40 }, (_, index) => `word${index}`).join(" ");
    const earlier = `${filler} and then we agreed to ship the beta on Fri`;
    const joined = joinChunkTexts([paused(earlier), overlapping("we agreed to ship the beta on Friday after the review.")]);
    expect(joined).toBe(`${filler} and then we agreed to ship the beta on Friday after the review.`);
  });

  test("an overlap is matched only near the seam", () => {
    const filler = Array.from({ length: config.chunkOverlapSearchWords }, (_, i) => `f${i}`).join(" ");
    // The shared words sit further than `chunkOverlapSearchWords` from the end of the earlier text.
    const left = `red green blue ${filler}`;
    const right = "red green blue again";
    expect(joinChunkTexts([paused(left), overlapping(right)])).toBe(`${left} ${right}`);
  });

  test("an overlap is matched only near the seam in the later text too", () => {
    const filler = Array.from({ length: config.chunkOverlapSearchWords }, (_, i) => `f${i}`).join(" ");
    // The shared words sit further than `chunkOverlapSearchWords` from the start of the later text.
    const left = "we start with red green blue";
    const right = `${filler} red green blue again`;
    expect(joinChunkTexts([paused(left), overlapping(right)])).toBe(`${left} ${right}`);
  });

  /** A chunk overlaps only the one just before it. After an empty one (a long silence not sent, or
   * nothing heard), matching it against an earlier chunk's words would cut out the speech between. */
  test("a chunk overlapping an empty one is joined whole, not matched against the chunk before that", () => {
    const first = "I think that one of the main points is the travel cost and the hotel.";
    const last = "Okay, back again. I think that one of the main points we missed is staffing.";
    for (const empty of ["", "  ", "…"]) {
      expect(joinChunkTexts([paused(first), overlapping(empty), overlapping(last)])).toBe(`${first} ${last}`);
    }
  });

  test("an overlap and an ellipsis together: the ellipsis goes, then the words are matched", () => {
    expect(joinChunkTexts([paused("we will meet on the second floor..."), overlapping("…on the second floor at noon")])).toBe("we will meet on the second floor at noon");
  });

  test("a whole earlier chunk repeated in the overlap is kept once", () => {
    expect(joinChunkTexts([paused("one two three"), overlapping("one two three four five")])).toBe("one two three four five");
  });
});
