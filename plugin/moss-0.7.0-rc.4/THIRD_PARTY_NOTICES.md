# Third-party notices and license boundaries

## Original project material — MIT

Original MOSS Workbench code and original documentation are licensed under the
[MIT license](<LICENSE>), copyright 2026 MOSS Workbench contributors. This grant
does not replace the separate licenses below.

## Moeblack reference material — CC-BY-NC-ND-4.0

The files under `vendor/moeblack/`, specifically the original
[SKILL.md](<vendor/moeblack/SKILL.md>), [README.md](<vendor/moeblack/README.md>) and
[LICENSE](<vendor/moeblack/LICENSE>), retain their original license and attribution.
[NOTICE.md](<vendor/moeblack/NOTICE.md>) records the author, source revision and
unchanged source digest.

- Author: Moeblack.
- Source: https://github.com/Moeblack/moss-image-prompt-skill
- Revision: `8de83f48a372f3056a7d5d2c1677460eab6c1f67`.
- Original SKILL SHA256: `ec1a3f32d47da81d3068da58a5a4e93380f7200f760ec3b207309599c3ab5c35`.
- License: **CC-BY-NC-ND-4.0**, not MIT.

Subject to its license conditions, unchanged material may be shared for
noncommercial purposes with the required attribution and notices. The license
does not grant commercial-use rights or permission to distribute adaptations,
including translated or rewritten versions. No endorsement by Moeblack is implied.
The complete license controls. The combined package must not be described as
unrestrictedly commercially usable merely because the original project code is MIT.

## Runtime dependencies and models

DSH core packages and React are provided by the compatible Host, not copied into
this package. Python dependencies and GBC source are installed separately from
pinned sources by an explicit operator action; their own licenses apply.
GBC/Togeari are distributed under their upstream licenses, not relicensed by MIT.
Model weights, ComfyUI, CUDA, and third-party ComfyUI nodes are not bundled.
Users must already possess and lawfully use the required models/nodes; gated or
separately licensed models require their own permissions. Setup does not accept
model licenses or automatically download weights on the user's behalf.
