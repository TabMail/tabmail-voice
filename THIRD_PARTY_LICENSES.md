# Third-party licences

TabMail Voice is licensed under the MPL 2.0 (`LICENSE`). It ships, or is built from, the open-source
projects and data below; Settings > Acknowledgements lists the same. Each project's own licence file
ships with it where the package carries one (the app's packages, inside the app; Electron's and
Chromium's beside it as `LICENSE.electron.txt` and `LICENSES.chromium.html`); the native code's are in
`THIRD_PARTY_NOTICES.md`. The texts of the licences named here follow the list.

## Electron

- **Source:** https://www.electronjs.org
- **Licence:** MIT License
- **Copyright:** Copyright (c) Electron contributors; Copyright (c) 2013-2020 GitHub Inc.
- **Used for:** The app's runtime.

## Chromium

- **Source:** https://www.chromium.org
- **Licence:** BSD 3-Clause License and its components' licences
- **Used for:** Electron's browser engine. Its components and their licences, FFmpeg (LGPL 2.1) among them, are listed in `LICENSES.chromium.html`, which ships with the app on Windows and Linux.

## React

- **Source:** https://react.dev
- **Licence:** MIT License
- **Copyright:** Copyright (c) Meta Platforms, Inc. and affiliates.
- **Used for:** The windows' user interface (React and React DOM).

## PDF.js

- **Source:** https://mozilla.github.io/pdf.js
- **Licence:** Apache License 2.0; its CMaps BSD 3-Clause License
- **Copyright:** CMaps: Copyright 1990-2009 Adobe Systems Incorporated
- **Used for:** Reading PDF files for agent mode (`pdfjs-dist`, with Adobe's character maps, whose licence ships beside them).

## QuickJS

- **Source:** https://bellard.org/quickjs/
- **Licence:** MIT License
- **Copyright:** Copyright (c) 2017-2021 Fabrice Bellard; Copyright (c) 2017-2021 Charlie Gordon
- **Used for:** The sandboxed JavaScript engine agent mode runs code in, compiled to WebAssembly (`@jitl/quickjs-wasmfile-release-sync`).

## quickjs-emscripten

- **Source:** https://github.com/justjake/quickjs-emscripten
- **Licence:** MIT License
- **Copyright:** Copyright (c) 2019-2024 Jake Teton-Landis
- **Used for:** QuickJS's JavaScript interface (`quickjs-emscripten-core`).

## keyring-node

- **Source:** https://github.com/Brooooooklyn/keyring-node
- **Licence:** MIT License
- **Copyright:** Copyright (c) 2020 N-API for Rust
- **Used for:** Keeping the sign-in in the system's keychain (`@napi-rs/keyring`).

## libdbus

- **Source:** https://www.freedesktop.org/wiki/Software/dbus
- **Licence:** Academic Free License 2.1 (or GNU GPL 2.0 or later; the AFL is the one taken)
- **Used for:** Built into keyring-node's Linux module (libdbus 1.14.4), to reach the Secret Service.

## electron-updater

- **Source:** https://github.com/electron-userland/electron-builder
- **Licence:** MIT License
- **Copyright:** Copyright (c) 2015 Loopline Systems
- **Used for:** Updating the app (with builder-util-runtime).

## jsonc-parser

- **Source:** https://github.com/microsoft/node-jsonc-parser
- **Licence:** MIT License
- **Copyright:** Copyright (c) Microsoft
- **Used for:** Reading VS Code's settings.

## abort-controller

- **Source:** https://github.com/mysticatea/abort-controller
- **Licence:** MIT License
- **Copyright:** Copyright (c) 2017 Toru Nagashima
- **Used for:** Cancelling work in agent mode's sandbox.

## web-streams-polyfill

- **Source:** https://github.com/MattiasBuelens/web-streams-polyfill
- **Licence:** MIT License
- **Copyright:** Copyright (c) 2026 Mattias Buelens; Copyright (c) 2016 Diwank Singh Tomer
- **Used for:** Streams in agent mode's sandbox.

## fst

- **Source:** https://github.com/BurntSushi/fst
- **Licence:** MIT License or Unlicense (MIT chosen)
- **Copyright:** Copyright (c) 2015 Andrew Gallant
- **Used for:** The helpers' shared core: the word list's lookup.

## ICU4X

- **Source:** https://github.com/unicode-org/icu4x
- **Licence:** Unicode License v3
- **Copyright:** Copyright © 2020-2024 Unicode, Inc.
- **Used for:** The helpers' shared core: case folding (`icu_casemap`).

## serde_json

- **Source:** https://github.com/serde-rs/json
- **Licence:** MIT License or Apache License 2.0
- **Used for:** The helpers' shared core: requests and replies.

## unicode-rs

- **Source:** https://github.com/unicode-rs
- **Licence:** MIT License or Apache License 2.0
- **Copyright:** Copyright (c) 2015 The Rust Project Developers; Copyright 2021 The Unicode-rs Developers
- **Used for:** The helpers' shared core: normalization, scripts, segmentation and widths (`unicode-normalization`, `unicode-script`, `unicode-segmentation`, `unicode-width`).

## rust-url

- **Source:** https://github.com/servo/rust-url
- **Licence:** MIT License or Apache License 2.0
- **Copyright:** Copyright (c) 2013-2025 The rust-url developers
- **Used for:** The helpers' shared core: website addresses (`url`).

## nlohmann/json

- **Source:** https://github.com/nlohmann/json
- **Licence:** MIT License
- **Copyright:** Copyright (c) 2013-2025 Niels Lohmann
- **Used for:** JSON in the Windows and Linux helpers.

## IAccessible2

- **Source:** https://github.com/LinuxA11y/IAccessible2
- **Licence:** BSD 3-Clause License
- **Copyright:** Copyright (c) 2007, 2013 Linux Foundation; Copyright (c) 2006 IBM Corporation; Copyright (c) 2000, 2006 Sun Microsystems, Inc.
- **Used for:** The Windows helpers' text interface declarations. The full notice ships as `helpers/IAccessible2-LICENSE.txt`.

## SQLite

- **Source:** https://sqlite.org
- **Licence:** Public domain
- **Used for:** The memory helper's database, built into it through rusqlite.

## rusqlite

- **Source:** https://github.com/rusqlite/rusqlite
- **Licence:** MIT License
- **Copyright:** Copyright (c) 2014-2021 The rusqlite developers
- **Used for:** The memory helper's database interface.

## sqlite-vec

- **Source:** https://github.com/asg017/sqlite-vec
- **Licence:** MIT License or Apache License 2.0
- **Used for:** The memory helper's vector search.

## Candle

- **Source:** https://github.com/huggingface/candle
- **Licence:** MIT License or Apache License 2.0
- **Used for:** The memory helper's embedding model runtime.

## Tokenizers

- **Source:** https://github.com/huggingface/tokenizers
- **Licence:** Apache License 2.0
- **Used for:** The memory helper's text tokenizer.

## safetensors

- **Source:** https://github.com/huggingface/safetensors
- **Licence:** Apache License 2.0
- **Used for:** Reading the embedding model's weights.

## Oniguruma

- **Source:** https://github.com/kkos/oniguruma
- **Licence:** BSD 2-Clause License
- **Copyright:** Copyright (c) 2002-2021 K.Kosako
- **Used for:** Regular expressions in the tokenizer (through `onig`, Copyright (c) 2015 Will Speak, Ivan Ivashchenko, MIT License).

## all-MiniLM-L6-v2

- **Source:** https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2
- **Licence:** Apache License 2.0
- **Used for:** The memory helper's embedding model, by Nils Reimers and the Sentence Transformers team. It is downloaded when memory is first used, not shipped in the app.

## ed25519-dalek

- **Source:** https://github.com/dalek-cryptography/curve25519-dalek
- **Licence:** BSD 3-Clause License
- **Copyright:** Copyright (c) 2017-2019 isis agora lovecruft; curve25519-dalek: Copyright (c) 2016-2021 isis agora lovecruft, Copyright (c) 2016-2021 Henry de Valence; subtle: Copyright (c) 2016-2017 Isis Agora Lovecruft, Henry de Valence
- **Used for:** Checking the embedding model's signature (with curve25519-dalek and subtle).

## ureq

- **Source:** https://github.com/algesten/ureq
- **Licence:** MIT License or Apache License 2.0
- **Copyright:** Copyright (c) 2019 Martin Algesten
- **Used for:** Downloading the embedding model.

## rustls

- **Source:** https://github.com/rustls/rustls
- **Licence:** Apache License 2.0, ISC License or MIT License
- **Copyright:** Copyright (c) 2016, Joseph Birr-Pixton
- **Used for:** TLS for that download.

## ring

- **Source:** https://github.com/briansmith/ring
- **Licence:** Apache License 2.0 and ISC License
- **Used for:** Cryptography for TLS. Parts come from BoringSSL (Apache License 2.0, ISC License) and once_cell (MIT License or Apache License 2.0).

## webpki-roots

- **Source:** https://github.com/rustls/webpki-roots
- **Licence:** CDLA Permissive 2.0
- **Used for:** Mozilla's root certificates, which TLS trusts.

## RustCrypto hashes

- **Source:** https://github.com/RustCrypto/hashes
- **Licence:** MIT License or Apache License 2.0
- **Copyright:** Copyright (c) 2006-2009 Graydon Hoare
- **Used for:** Checking the embedding model's files (`sha2`).

## chrono

- **Source:** https://github.com/chronotope/chrono
- **Licence:** MIT License or Apache License 2.0
- **Copyright:** Copyright (c) 2014, Kang Seonghoon
- **Used for:** Dates in the memory helper.

## flexi_logger

- **Source:** https://github.com/emabee/flexi_logger
- **Licence:** MIT License or Apache License 2.0
- **Copyright:** Copyright (c) 2018 The AUTHORS
- **Used for:** The memory helper's log.

## FrequencyWords

- **Source:** https://github.com/hermitdave/FrequencyWords
- **Licence:** CC BY-SA 4.0 (content; its code is MIT License)
- **Copyright:** Copyright (c) 2016 Hermit Dave
- **Used for:** Word counts of OpenSubtitles 2018, adapted into the word list screen terms are judged by (`apps/desktop/native/shared/dictionary/words.txt`), which is licensed CC BY-SA 4.0 too. The changes are described in that folder's `README.md`, which ships beside the list.

## OpenSubtitles 2018

- **Source:** https://www.opensubtitles.org
- **Licence:** The subtitles FrequencyWords counted
- **Used for:** The corpus behind FrequencyWords' counts, through OPUS (https://opus.nlpl.eu/OpenSubtitles2018.php): P. Lison and J. Tiedemann (2016), "OpenSubtitles2016: Extracting Large Parallel Corpora from Movie and TV Subtitles", LREC 2016.

## wordfreq

- **Source:** https://github.com/rspeer/wordfreq
- **Licence:** Apache License 2.0 (code), CC BY-SA 4.0 (data)
- **Copyright:** Copyright 2022 Robyn Speer
- **Used for:** Its code puts each word in the form the list holds it in, and its letter tables are copied into the lists' catalog (`languages.json`, CC BY-SA 4.0 for that reason). Its word frequencies are not used. As it asks, the SUBTLEX authors are credited in the word list's README.

## OpenCC

- **Source:** https://github.com/BYVoid/OpenCC
- **Licence:** Apache License 2.0
- **Used for:** wordfreq's Traditional to Simplified Chinese table was made with it.

## Unicode CLDR

- **Source:** https://cldr.unicode.org
- **Licence:** Unicode License v3
- **Copyright:** Copyright © 2015-2024 Unicode, Inc. (CLDR JSON 48)
- **Used for:** The letters each language is written in, which name each list's scripts.

## Other open-source components

- **Source:** https://github.com/TabMail/tabmail-voice/blob/main/THIRD_PARTY_NOTICES.md
- **Licence:** MIT, Apache 2.0, ISC, BSD, Zlib, Unlicense, Unicode v3, CDLA Permissive 2.0, Blue Oak 1.0.0 and Python 2.0 licences
- **Used for:** The npm packages and Rust crates the projects above build on. Each npm package's licence ships with it inside the app; `THIRD_PARTY_NOTICES.md`, generated from the lockfiles and shipped in every package, holds the licence texts of the native code compiled in (the Rust crates, the C libraries they bundle, nlohmann/json and the Rust standard library), and `voice-memory-THIRD_PARTY_NOTICES.txt` the memory helper's.

# Licence texts

Each text applies to the projects above under that licence, with each project's copyright as listed.

## MIT License

```text
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## BSD 2-Clause License

```text
Redistribution and use in source and binary forms, with or without modification, are permitted
provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions
   and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of
   conditions and the following disclaimer in the documentation and/or other materials provided
   with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR
IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR
CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER
IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT
OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## BSD 3-Clause License

```text
Redistribution and use in source and binary forms, with or without modification, are permitted
provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions
   and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of
   conditions and the following disclaimer in the documentation and/or other materials provided
   with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors may be used to
   endorse or promote products derived from this software without specific prior written
   permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR
IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR
CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER
IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT
OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## ISC License

```text
Permission to use, copy, modify, and/or distribute this software for any purpose with or without
fee is hereby granted, provided that the above copyright notice and this permission notice appear
in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS
SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE
AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT,
NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

## Apache License 2.0

```text
                              Apache License
                        Version 2.0, January 2004
                     http://www.apache.org/licenses/

TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

1. Definitions.

   "License" shall mean the terms and conditions for use, reproduction,
   and distribution as defined by Sections 1 through 9 of this document.

   "Licensor" shall mean the copyright owner or entity authorized by
   the copyright owner that is granting the License.

   "Legal Entity" shall mean the union of the acting entity and all
   other entities that control, are controlled by, or are under common
   control with that entity. For the purposes of this definition,
   "control" means (i) the power, direct or indirect, to cause the
   direction or management of such entity, whether by contract or
   otherwise, or (ii) ownership of fifty percent (50%) or more of the
   outstanding shares, or (iii) beneficial ownership of such entity.

   "You" (or "Your") shall mean an individual or Legal Entity
   exercising permissions granted by this License.

   "Source" form shall mean the preferred form for making modifications,
   including but not limited to software source code, documentation
   source, and configuration files.

   "Object" form shall mean any form resulting from mechanical
   transformation or translation of a Source form, including but
   not limited to compiled object code, generated documentation,
   and conversions to other media types.

   "Work" shall mean the work of authorship, whether in Source or
   Object form, made available under the License, as indicated by a
   copyright notice that is included in or attached to the work
   (an example is provided in the Appendix below).

   "Derivative Works" shall mean any work, whether in Source or Object
   form, that is based on (or derived from) the Work and for which the
   editorial revisions, annotations, elaborations, or other modifications
   represent, as a whole, an original work of authorship. For the purposes
   of this License, Derivative Works shall not include works that remain
   separable from, or merely link (or bind by name) to the interfaces of,
   the Work and Derivative Works thereof.

   "Contribution" shall mean any work of authorship, including
   the original version of the Work and any modifications or additions
   to that Work or Derivative Works thereof, that is intentionally
   submitted to Licensor for inclusion in the Work by the copyright owner
   or by an individual or Legal Entity authorized to submit on behalf of
   the copyright owner. For the purposes of this definition, "submitted"
   means any form of electronic, verbal, or written communication sent
   to the Licensor or its representatives, including but not limited to
   communication on electronic mailing lists, source code control systems,
   and issue tracking systems that are managed by, or on behalf of, the
   Licensor for the purpose of discussing and improving the Work, but
   excluding communication that is conspicuously marked or otherwise
   designated in writing by the copyright owner as "Not a Contribution."

   "Contributor" shall mean Licensor and any individual or Legal Entity
   on behalf of whom a Contribution has been received by Licensor and
   subsequently incorporated within the Work.

2. Grant of Copyright License. Subject to the terms and conditions of
   this License, each Contributor hereby grants to You a perpetual,
   worldwide, non-exclusive, no-charge, royalty-free, irrevocable
   copyright license to reproduce, prepare Derivative Works of,
   publicly display, publicly perform, sublicense, and distribute the
   Work and such Derivative Works in Source or Object form.

3. Grant of Patent License. Subject to the terms and conditions of
   this License, each Contributor hereby grants to You a perpetual,
   worldwide, non-exclusive, no-charge, royalty-free, irrevocable
   (except as stated in this section) patent license to make, have made,
   use, offer to sell, sell, import, and otherwise transfer the Work,
   where such license applies only to those patent claims licensable
   by such Contributor that are necessarily infringed by their
   Contribution(s) alone or by combination of their Contribution(s)
   with the Work to which such Contribution(s) was submitted. If You
   institute patent litigation against any entity (including a
   cross-claim or counterclaim in a lawsuit) alleging that the Work
   or a Contribution incorporated within the Work constitutes direct
   or contributory patent infringement, then any patent licenses
   granted to You under this License for that Work shall terminate
   as of the date such litigation is filed.

4. Redistribution. You may reproduce and distribute copies of the
   Work or Derivative Works thereof in any medium, with or without
   modifications, and in Source or Object form, provided that You
   meet the following conditions:

   (a) You must give any other recipients of the Work or
       Derivative Works a copy of this License; and

   (b) You must cause any modified files to carry prominent notices
       stating that You changed the files; and

   (c) You must retain, in the Source form of any Derivative Works
       that You distribute, all copyright, patent, trademark, and
       attribution notices from the Source form of the Work,
       excluding those notices that do not pertain to any part of
       the Derivative Works; and

   (d) If the Work includes a "NOTICE" text file as part of its
       distribution, then any Derivative Works that You distribute must
       include a readable copy of the attribution notices contained
       within such NOTICE file, excluding those notices that do not
       pertain to any part of the Derivative Works, in at least one
       of the following places: within a NOTICE text file distributed
       as part of the Derivative Works; within the Source form or
       documentation, if provided along with the Derivative Works; or,
       within a display generated by the Derivative Works, if and
       wherever such third-party notices normally appear. The contents
       of the NOTICE file are for informational purposes only and
       do not modify the License. You may add Your own attribution
       notices within Derivative Works that You distribute, alongside
       or as an addendum to the NOTICE text from the Work, provided
       that such additional attribution notices cannot be construed
       as modifying the License.

   You may add Your own copyright statement to Your modifications and
   may provide additional or different license terms and conditions
   for use, reproduction, or distribution of Your modifications, or
   for any such Derivative Works as a whole, provided Your use,
   reproduction, and distribution of the Work otherwise complies with
   the conditions stated in this License.

5. Submission of Contributions. Unless You explicitly state otherwise,
   any Contribution intentionally submitted for inclusion in the Work
   by You to the Licensor shall be under the terms and conditions of
   this License, without any additional terms or conditions.
   Notwithstanding the above, nothing herein shall supersede or modify
   the terms of any separate license agreement you may have executed
   with Licensor regarding such Contributions.

6. Trademarks. This License does not grant permission to use the trade
   names, trademarks, service marks, or product names of the Licensor,
   except as required for reasonable and customary use in describing the
   origin of the Work and reproducing the content of the NOTICE file.

7. Disclaimer of Warranty. Unless required by applicable law or
   agreed to in writing, Licensor provides the Work (and each
   Contributor provides its Contributions) on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
   implied, including, without limitation, any warranties or conditions
   of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
   PARTICULAR PURPOSE. You are solely responsible for determining the
   appropriateness of using or redistributing the Work and assume any
   risks associated with Your exercise of permissions under this License.

8. Limitation of Liability. In no event and under no legal theory,
   whether in tort (including negligence), contract, or otherwise,
   unless required by applicable law (such as deliberate and grossly
   negligent acts) or agreed to in writing, shall any Contributor be
   liable to You for damages, including any direct, indirect, special,
   incidental, or consequential damages of any character arising as a
   result of this License or out of the use or inability to use the
   Work (including but not limited to damages for loss of goodwill,
   work stoppage, computer failure or malfunction, or any and all
   other commercial damages or losses), even if such Contributor
   has been advised of the possibility of such damages.

9. Accepting Warranty or Additional Liability. While redistributing
   the Work or Derivative Works thereof, You may choose to offer,
   and charge a fee for, acceptance of support, warranty, indemnity,
   or other liability obligations and/or rights consistent with this
   License. However, in accepting such obligations, You may act only
   on Your own behalf and on Your sole responsibility, not on behalf
   of any other Contributor, and only if You agree to indemnify,
   defend, and hold each Contributor harmless for any liability
   incurred by, or claims asserted against, such Contributor by reason
   of your accepting any such warranty or additional liability.

END OF TERMS AND CONDITIONS
```

## Unicode License v3

```text
UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 2020-2024 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.

SPDX-License-Identifier: Unicode-3.0

—

Portions of ICU4X may have been adapted from ICU4C and/or ICU4J.
ICU 1.8.1 to ICU 57.1 © 1995-2016 International Business Machines Corporation and others.
```

## CDLA Permissive 2.0

```text
# Community Data License Agreement - Permissive - Version 2.0

This is the Community Data License Agreement - Permissive, Version
2.0 (the "agreement"). Data Provider(s) and Data Recipient(s) agree
as follows:

## 1. Provision of the Data

1.1. A Data Recipient may use, modify, and share the Data made
available by Data Provider(s) under this agreement if that Data
Recipient follows the terms of this agreement.

1.2. This agreement does not impose any restriction on a Data
Recipient's use, modification, or sharing of any portions of the
Data that are in the public domain or that may be used, modified,
or shared under any other legal exception or limitation.

## 2. Conditions for Sharing Data

2.1. A Data Recipient may share Data, with or without modifications, so
long as the Data Recipient makes available the text of this agreement
with the shared Data.

## 3. No Restrictions on Results

3.1. This agreement does not impose any restriction or obligations
with respect to the use, modification, or sharing of Results.

## 4. No Warranty; Limitation of Liability

4.1. All Data Recipients receive the Data subject to the following
terms:

THE DATA IS PROVIDED ON AN "AS IS" BASIS, WITHOUT REPRESENTATIONS,
WARRANTIES OR CONDITIONS OF ANY KIND, EITHER EXPRESS OR IMPLIED
INCLUDING, WITHOUT LIMITATION, ANY WARRANTIES OR CONDITIONS OF TITLE,
NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.

NO DATA PROVIDER SHALL HAVE ANY LIABILITY FOR ANY DIRECT, INDIRECT,
INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING
WITHOUT LIMITATION LOST PROFITS), HOWEVER CAUSED AND ON ANY THEORY OF
LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE DATA OR RESULTS,
EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.

## 5. Definitions

5.1. "Data" means the material received by a Data Recipient under
this agreement.

5.2. "Data Provider" means any person who is the source of Data
provided under this agreement and in reliance on a Data Recipient's
agreement to its terms.

5.3. "Data Recipient" means any person who receives Data directly
or indirectly from a Data Provider and agrees to the terms of this
agreement.

5.4. "Results" means any outcome obtained by computational analysis
of Data, including for example machine learning models and models'
insights.
```

## CC BY-SA 4.0

Creative Commons Attribution-ShareAlike 4.0 International: https://creativecommons.org/licenses/by-sa/4.0/legalcode

## Unlicense

fst is also offered under the Unlicense (https://unlicense.org); the MIT License above is the one taken.

## Academic Free License 2.1

libdbus's licence, which its source's `COPYING` names: https://opensource.org/license/afl-2-1.
