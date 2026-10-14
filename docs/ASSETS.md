# Assets, credits and licences

DotKick is an original game (brief section 2). Everything you see or hear is generated in code, except the open-source
parts listed here with their name, address and licence. There are no images, sounds, models, textures or fonts from
anywhere else, and nothing from any commercial game.

Versions are the exact pinned versions in `package.json` / `package-lock.json`. When a dependency is added, removed or
upgraded, update this page in the same change (`tests/unit/plt-06-docs.test.ts` checks that every runtime dependency is
listed here with its pinned version and licence).

## Shipped in the game (`dist/index.html`)

| Name | Version | What it is used for | Address | Licence | Copyright |
|---|---|---|---|---|---|
| Space Grotesk (font) | via `@fontsource/space-grotesk` 5.3.0 | Menu and HUD text. Latin subset, weights 400, 500 and 700, inlined as woff2 | [github.com/floriankarsten/space-grotesk](https://github.com/floriankarsten/space-grotesk), package [fontsource.org/fonts/space-grotesk](https://fontsource.org/fonts/space-grotesk) | SIL Open Font License 1.1 (OFL-1.1) | Copyright 2020 The Space Grotesk Project Authors |
| JetBrains Mono (font) | via `@fontsource/jetbrains-mono` 5.3.0 | Clock, scores, stats and other numbers. Latin subset, weights 400 and 600, inlined as woff2 | [github.com/JetBrains/JetBrainsMono](https://github.com/JetBrains/JetBrainsMono), package [fontsource.org/fonts/jetbrains-mono](https://fontsource.org/fonts/jetbrains-mono) | SIL Open Font License 1.1 (OFL-1.1) | Copyright 2020 The JetBrains Mono Project Authors |
| three.js | 0.186.1 | 3D rendering (WebGL2) | [threejs.org](https://threejs.org/), [github.com/mrdoob/three.js](https://github.com/mrdoob/three.js) | MIT | Copyright © 2010-2026 three.js authors |
| PeerJS | 1.5.5 | Online 1v1: peer-to-peer connection over WebRTC data channels | [peerjs.com](https://peerjs.com/), [github.com/peers/peerjs](https://github.com/peers/peerjs) | MIT | Copyright (c) 2015 Michelle Bu and Eric Zhang |

PeerJS brings these libraries with it; they are bundled into the game together with PeerJS for online 1v1:

| Name | Version | Address | Licence | Copyright |
|---|---|---|---|---|
| peerjs-js-binarypack | 2.1.0 | [github.com/peers/js-binarypack](https://github.com/peers/js-binarypack) | MIT | Copyright (c) 2012 Eric Zhang |
| webrtc-adapter | 9.0.6 | [github.com/webrtcHacks/adapter](https://github.com/webrtcHacks/adapter) | BSD-3-Clause | Copyright (c) 2014, The WebRTC project authors; Copyright (c) 2018, The adapter.js project authors |
| sdp (used by webrtc-adapter) | 3.2.2 | [github.com/fippo/sdp](https://github.com/fippo/sdp) | MIT | Copyright (c) 2017 Philipp Hancke |
| @msgpack/msgpack | 2.8.0 | [github.com/msgpack/msgpack-javascript](https://github.com/msgpack/msgpack-javascript) | ISC | Copyright 2019 The MessagePack Community |
| eventemitter3 | 4.0.7 | [github.com/primus/eventemitter3](https://github.com/primus/eventemitter3) | MIT | Copyright (c) 2014 Arnout Kazemier |

The fonts are used unmodified apart from the Latin subsetting that the @fontsource packages ship. Their reserved font
names are not used for anything else. The full licence texts are at the end of this page.

## Made in code (no outside source)

| What | Where it is made |
|---|---|
| App icons (`public/icons/*.png`) | `tools/gen-icons.mjs` draws the DotKick mark and encodes the PNG files |
| Pitch, stadium, crowd, players, kits, numbers, ball, nets, effects | `src/render/` (geometry, colours and texture atlases generated at load) |
| Menus, HUD, the dot-field background, button glyphs | `src/ui/` and `src/input/pad/glyphs.ts` (DOM, CSS, canvas and inline SVG drawn in code; controller glyphs are plain shapes and letters, no logos) |
| All sound: crowd, whistles, kicks, voices, menu sounds | `src/audio/` (synthesised with the Web Audio API) |
| Teams, players, names, kits, formations | `src/data/` (invented; `tools/gen-data.ts` generates the club list) |

## Online services used by online 1v1 only

These are not assets, but they are the only places the game connects to, and only while you play online 1v1:

| Service | Address | Role |
|---|---|---|
| PeerJS public broker (PeerJS Cloud) | `0.peerjs.com` (port 443) | Introduces the two players (signalling). Free, no key |
| STUN server (PeerJS default) | `stun.l.google.com:19302` | Lets each device learn its public address for the direct link |
| TURN relays (PeerJS default) | `eu-0.turn.peerjs.com:3478`, `us-0.turn.peerjs.com:3478` | Relay the match data when a direct link is impossible |

All of them are set in one place, `NET_CONFIG` in `src/net/config.ts`, and can be replaced by your own servers
([DEPLOY.md](DEPLOY.md#self-hosted-peerjs-server-optional)).

## Build and test tools (not shipped)

These run on a developer's computer or in CI and are not part of the game files.

| Name | Version | Licence | Address |
|---|---|---|---|
| Vite | 8.3.4 | MIT | [vite.dev](https://vite.dev/) |
| vite-plugin-singlefile | 2.3.3 | MIT | [github.com/richardtallent/vite-plugin-singlefile](https://github.com/richardtallent/vite-plugin-singlefile) |
| TypeScript | 5.9.3 | Apache-2.0 | [typescriptlang.org](https://www.typescriptlang.org/) |
| Vitest | 5.0.4 | MIT | [vitest.dev](https://vitest.dev/) |
| Playwright (`@playwright/test`) | 1.56.1 | Apache-2.0 | [playwright.dev](https://playwright.dev/) |
| ESLint, `@eslint/js` | 10.12.0, 10.0.1 | MIT | [eslint.org](https://eslint.org/) |
| typescript-eslint | 8.71.1 | MIT | [typescript-eslint.io](https://typescript-eslint.io/) |
| tsx | 4.23.15 | MIT | [tsx.hirok.io](https://tsx.hirok.io/) |
| `@types/node`, `@types/three` | 22.19.1, 0.186.0 | MIT | [github.com/DefinitelyTyped/DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) |

## Licence texts

### MIT (three.js)

```text
The MIT License

Copyright © 2010-2026 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### MIT (PeerJS)

```text
Copyright (c) 2015 Michelle Bu and Eric Zhang, http://peerjs.com

(The MIT License)

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### MIT (peerjs-js-binarypack)

```text
Copyright (c) 2012 Eric Zhang, http://binaryjs.com

(The MIT License)

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### MIT (sdp)

```text
Copyright (c) 2017 Philipp Hancke

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### MIT (eventemitter3)

```text
The MIT License (MIT)

Copyright (c) 2014 Arnout Kazemier

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### ISC (@msgpack/msgpack)

```text
Copyright 2019 The MessagePack Community.

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### BSD-3-Clause (webrtc-adapter)

```text
Copyright (c) 2014, The WebRTC project authors. All rights reserved.
Copyright (c) 2018, The adapter.js project authors. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

  * Redistributions of source code must retain the above copyright
    notice, this list of conditions and the following disclaimer.

  * Redistributions in binary form must reproduce the above copyright
    notice, this list of conditions and the following disclaimer in
    the documentation and/or other materials provided with the
    distribution.

  * Neither the name of Google nor the names of its contributors may
    be used to endorse or promote products derived from this software
    without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### SIL Open Font License 1.1 (Space Grotesk and JetBrains Mono)

Space Grotesk: Copyright 2020 The Space Grotesk Project Authors (https://github.com/floriankarsten/space-grotesk)

JetBrains Mono: Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)

```text
This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```
