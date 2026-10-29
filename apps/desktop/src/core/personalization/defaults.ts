// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Thunderbird's add-on's writing style (its `prompts/user_composition.md`), as written: the lines
 * around its sections are the built-in skeleton (DS-SKELETON). Its bullets, and the knowledge base's,
 * are the shared default catalog's (`sync/device-sync-default-catalog.json`, DS-DEFAULT). */

export const defaultComposition = [
  "# User provided composition instructions",
  "- Below are the user-defined instructions for composing emails.",
  "- Strictly follow these instructions in future responses.",
  "",
  "====BEGIN USER INSTRUCTIONS====",
  "",
  "",
  "# General writing style (DO NOT EDIT/DELETE THIS SECTION HEADER)",
  "- ALWAYS sign off as the user using the **First Name Only**.",
  "- I want to sound friendly and professional, but not too formal. ",
  "- ALWAYS start with a greeting.",
  "- I generally use Cheers or Best, depending on the context. Or if I really want to be formal, I use Sincerely or Best regards. For replying to application enquiries, I use Best wishes.",
  "",
  "# Language (DO NOT EDIT/DELETE THIS SECTION HEADER)",
  "- I write in English Only.",
  "",
  "# Useful links to personal website and other resources (DO NOT EDIT/DELETE THIS SECTION HEADER)",
  "- [TabMail Website](https://tabmail.ai)",
  "- [TabMail Support](https://tabmail.ai/support)",
  "",
  "====END USER INSTRUCTIONS====",
  "",
  "Now, acknowledge these user instructions and do not deviate from them.",
].join("\n");
