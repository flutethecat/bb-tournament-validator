# Dice face generation v3

Generated with the built-in `image_gen` tool: exactly 24 calls, one call per face. Every call used `transparent_background: true` and the two reference image paths listed below. All six D6 references and the matching block-face-pow.png were visually studied before generation; the block image was not passed to generation.

Final images were normalized with Windows PowerShell System.Drawing, using HighQualityBicubic resampling, high-quality compositing and pixel offsets, SourceCopy, and 32-bit ARGB. The full generated image was resampled into a 510 x 510 rectangle at (1, 1) on a transparent 512 x 512 canvas. This preserves generated alpha and supplies a fully transparent one-pixel outer guard against near-invisible alpha-1 pixels in the generated margins. No cropping or numeral repainting was performed.

Validation: all 24 final files were reopened, confirmed as 512 x 512 PNGs with alpha and a fully transparent outer margin, and visually checked for the correct numeral. Both face-6 files and d16-face-9.png have a metal underline. SHA-256 values below refer to the final normalized files.

## d8-face-1.png

- File: `tools/art/dice/masters/d8-face-1.png`
- SHA-256: `E92A9F276D27FF2F2462DE1D03635DE775E1D046328F0003B36661058031EFED`
- Reference image 1: `tools/art/dice/reference/d6-brushed-metal-face-1.png`
- Reference image 2: `tools/art/dice/reference/d6-brushed-metal-face-4.png`
- Exact `referenced_image_paths` argument:

```json
[
  "tools/art/dice/reference/d6-brushed-metal-face-1.png",
  "tools/art/dice/reference/d6-brushed-metal-face-4.png"
]
```

Exact prompt:

```text
Use case: stylized-concept.
Asset type: one square metallic numbered dice-face PNG, D8 face 1.
Input images: Image 1 (d6-brushed-metal-face-1.png) and Image 2 (d6-brushed-metal-face-4.png) are the owner's original style references. Match their tile design, materials, lighting, frame and framing precisely; replace all circular pips with the specified numeral.
Primary request: Render exactly ONE face showing ONLY the numeral "1", optically centered. It must read as another face of the SAME SET as the supplied D6 images.
Tile: straight-on square dark charcoal brushed-metal tile with very fine horizontal brushing, small chamfered corners, the same thin beveled grey steel frame, fine inner edge, and exactly two small RED diagonal corner ticks, at top-left and bottom-right. Keep the outer tile square with only small clipped corners, never an octagon or a polyhedron outline. Match the references' soft upper-left illumination, restrained highlights and subtle depth.
Numeral: "1" in bold, clean, blocky sans-serif numerals, about 45% of the tile height. Use one large centered digit. The numeral itself is polished, slightly domed silver/steel, with softly curved reflective highlights matching the D6 pips, beveled edges and a thin dark recessed outline around its metal silhouette. It must look like raised polished metal set into the brushed tile, with subtle contact shadow, not printed ink. Do not add an underline.
Composition: one isolated face, front-on and upright, square image, whole tile visible, approximately 86% of canvas width and height, centered with transparent margin on every side matching the D6 framing. The tile interior is opaque. Outside the tile use actual PNG alpha transparency, not a checkerboard, white background, black rectangle, or backdrop.
Constraints: no pips, no other text, no die-type label, no logos, no Games Workshop or FUMBBL imagery, no copied published dice designs. No flat vector look, no pixel art, no cartoon outline, no white face, no extra ornamental details. Preserve the same reference tile appearance and keep the numeral highly readable.
```

## d8-face-2.png

- File: `tools/art/dice/masters/d8-face-2.png`
- SHA-256: `6EAA1FB0B5E3B6A16B2C7A855739E819789B471CA811487F927CDB799B46A7AD`
- Reference image 1: `tools/art/dice/reference/d6-brushed-metal-face-1.png`
- Reference image 2: `tools/art/dice/reference/d6-brushed-metal-face-4.png`
- Exact `referenced_image_paths` argument:

```json
[
  "tools/art/dice/reference/d6-brushed-metal-face-1.png",
  "tools/art/dice/reference/d6-brushed-metal-face-4.png"
]
```

Exact prompt:

```text
Use case: stylized-concept.
Asset type: one square metallic numbered dice-face PNG, D8 face 2.
Input images: Image 1 (d6-brushed-metal-face-1.png) and Image 2 (d6-brushed-metal-face-4.png) are the owner's original style references. Match their tile design, materials, lighting, frame and framing precisely; replace all circular pips with the specified numeral.
Primary request: Render exactly ONE face showing ONLY the numeral "2", optically centered. It must read as another face of the SAME SET as the supplied D6 images.
Tile: straight-on square dark charcoal brushed-metal tile with very fine horizontal brushing, small chamfered corners, the same thin beveled grey steel frame, fine inner edge, and exactly two small RED diagonal corner ticks, at top-left and bottom-right. Keep the outer tile square with only small clipped corners, never an octagon or a polyhedron outline. Match the references' soft upper-left illumination, restrained highlights and subtle depth.
Numeral: "2" in bold, clean, blocky sans-serif numerals, about 45% of the tile height. Use one large centered digit. The numeral itself is polished, slightly domed silver/steel, with softly curved reflective highlights matching the D6 pips, beveled edges and a thin dark recessed outline around its metal silhouette. It must look like raised polished metal set into the brushed tile, with subtle contact shadow, not printed ink. Do not add an underline.
Composition: one isolated face, front-on and upright, square image, whole tile visible, approximately 86% of canvas width and height, centered with transparent margin on every side matching the D6 framing. The tile interior is opaque. Outside the tile use actual PNG alpha transparency, not a checkerboard, white background, black rectangle, or backdrop.
Constraints: no pips, no other text, no die-type label, no logos, no Games Workshop or FUMBBL imagery, no copied published dice designs. No flat vector look, no pixel art, no cartoon outline, no white face, no extra ornamental details. Preserve the same reference tile appearance and keep the numeral highly readable.
```

## d8-face-3.png

- File: `tools/art/dice/masters/d8-face-3.png`
- SHA-256: `9EF7E86744F32E895BA3AB9D9F8D68D36F6674BD1A8BEFEF8A78A94FF1349151`
- Reference image 1: `tools/art/dice/reference/d6-brushed-metal-face-1.png`
- Reference image 2: `tools/art/dice/reference/d6-brushed-metal-face-4.png`
- Exact `referenced_image_paths` argument:

```json
[
  "tools/art/dice/reference/d6-brushed-metal-face-1.png",
  "tools/art/dice/reference/d6-brushed-metal-face-4.png"
]
```

Exact prompt:

```text
Use case: stylized-concept.
Asset type: one square metallic numbered dice-face PNG, D8 face 3.
Input images: Image 1 (d6-brushed-metal-face-1.png) and Image 2 (d6-brushed-metal-face-4.png) are the owner's original style references. Match their tile design, materials, lighting, frame and framing precisely; replace all circular pips with the specified numeral.
Primary request: Render exactly ONE face showing ONLY the numeral "3", optically centered. It must read as another face of the SAME SET as the supplied D6 images.
Tile: straight-on square dark charcoal brushed-metal tile with very fine horizontal brushing, small chamfered corners, the same thin beveled grey steel frame, fine inner edge, and exactly two small RED diagonal corner ticks, at top-left and bottom-right. Keep the outer tile square with only small clipped corners, never an octagon or a polyhedron outline. Match the references' soft upper-left illumination, restrained highlights and subtle depth.
Numeral: "3" in bold, clean, blocky sans-serif numerals, about 45% of the tile height. Use one large centered digit. The numeral itself is polished, slightly domed silver/steel, with softly curved reflective highlights matching the D6 pips, beveled edges and a thin dark recessed outline around its metal silhouette. It must look like raised polished metal set into the brushed tile, with subtle contact shadow, not printed ink. Do not add an underline.
Composition: one isolated face, front-on and upright, square image, whole tile visible, approximately 86% of canvas width and height, centered with transparent margin on every side matching the D6 framing. The tile interior is opaque. Outside the tile use actual PNG alpha transparency, not a checkerboard, white background, black rectangle, or backdrop.
Constraints: no pips, no other text, no die-type label, no logos, no Games Workshop or FUMBBL imagery, no copied published dice designs. No flat vector look, no pixel art, no cartoon outline, no white face, no extra ornamental details. Preserve the same reference tile appearance and keep the numeral highly readable.
```

## d8-face-4.png

- File: `tools/art/dice/masters/d8-face-4.png`
- SHA-256: `A68AC3B4012DF86E434397A995053F146232665F4249B3820A8822A352341FD1`
- Reference image 1: `tools/art/dice/reference/d6-brushed-metal-face-1.png`
- Reference image 2: `tools/art/dice/reference/d6-brushed-metal-face-4.png`
- Exact `referenced_image_paths` argument:

```json
[
  "tools/art/dice/reference/d6-brushed-metal-face-1.png",
  "tools/art/dice/reference/d6-brushed-metal-face-4.png"
]
```

Exact prompt:

```text
Use case: stylized-concept.
Asset type: one square metallic numbered dice-face PNG, D8 face 4.
Input images: Image 1 (d6-brushed-metal-face-1.png) and Image 2 (d6-brushed-metal-face-4.png) are the owner's original style references. Match their tile design, materials, lighting, frame and framing precisely; replace all circular pips with the specified numeral.
Primary request: Render exactly ONE face showing ONLY the numeral "4", optically centered. It must read as another face of the SAME SET as the supplied D6 images.
Tile: straight-on square dark charcoal brushed-metal tile with very fine horizontal brushing, small chamfered corners, the same thin beveled grey steel frame, fine inner edge, and exactly two small RED diagonal corner ticks, at top-left and bottom-right. Keep the outer tile square with only small clipped corners, never an octagon or a polyhedron outline. Match the references' soft upper-left illumination, restrained highlights and subtle depth.
Numeral: "4" in bold, clean, blocky sans-serif numerals, about 45% of the tile height. Use one large centered digit. The numeral itself is polished, slightly domed silver/steel, with softly curved reflective highlights matching the D6 pips, beveled edges and a thin dark recessed outline around its metal silhouette. It must look like raised polished metal set into the brushed tile, with subtle contact shadow, not printed ink. Do not add an underline.
Composition: one isolated face, front-on and upright, square image, whole tile visible, approximately 86% of canvas width and height, centered with transparent margin on every side matching the D6 framing. The tile interior is opaque. Outside the tile use actual PNG alpha transparency, not a checkerboard, white background, black rectangle, or backdrop.
Constraints: no pips, no other text, no die-type label, no logos, no Games Workshop or FUMBBL imagery, no copied published dice designs. No flat vector look, no pixel art, no cartoon outline, no white face, no extra ornamental details. Preserve the same reference tile appearance and keep the numeral highly readable.
```

## d8-face-5.png

- File: `tools/art/dice/masters/d8-face-5.png`
- SHA-256: `A579BB2B16312DAA308D29C68EDB09AEC6E8331D85F1A9E864A67D266AF8D7D7`
- Reference image 1: `tools/art/dice/reference/d6-brushed-metal-face-1.png`
- Reference image 2: `tools/art/dice/reference/d6-brushed-metal-face-4.png`
- Exact `referenced_image_paths` argument:

```json
[
  "tools/art/dice/reference/d6-brushed-metal-face-1.png",
  "tools/art/dice/reference/d6-brushed-metal-face-4.png"
]
```

Exact prompt:

```text
Use case: stylized-concept.
Asset type: one square metallic numbered dice-face PNG, D8 face 5.
Input images: Image 1 (d6-brushed-metal-face-1.png) and Image 2 (d6-brushed-metal-face-4.png) are the owner's original style references. Match their tile design, materials, lighting, frame and framing precisely; replace all circular pips with the specified numeral.
Primary request: Render exactly ONE face showing ONLY the numeral "5", optically centered. It must read as another face of the SAME SET as the supplied D6 images.
Tile: straight-on square dark charcoal brushed-metal tile with very fine horizontal brushing, small chamfered corners, the same thin beveled grey steel frame, fine inner edge, and exactly two small RED diagonal corner ticks, at top-left and bottom-right. Keep the outer tile square with only small clipped corners, never an octagon or a polyhedron outline. Match the references' soft upper-left illumination, restrained highlights and subtle depth.
Numeral: "5" in bold, clean, blocky sans-serif numerals, about 45% of the tile height. Use one large centered digit. The numeral itself is polished, slightly domed silver/steel, with softly curved reflective highlights matching the D6 pips, beveled edges and a thin dark recessed outline around its metal silhouette. It must look like raised polished metal set into the brushed tile, with subtle contact shadow, not printed ink. Do not add an underline.
Composition: one isolated face, front-on and upright, square image, whole tile visible, approximately 86% of canvas width and height, centered with transparent margin on every side matching the D6 framing. The tile interior is opaque. Outside the tile use actual PNG alpha transparency, not a checkerboard, white background, black rectangle, or backdrop.
Constraints: no pips, no other text, no die-type label, no logos, no Games Workshop or FUMBBL imagery, no copied published dice designs. No flat vector look, no pixel art, no cartoon outline, no white face, no extra ornamental details. Preserve the same reference tile appearance and keep the numeral highly readable.
```

## d8-face-6.png

- File: `tools/art/dice/masters/d8-face-6.png`
- SHA-256: `D84BCDE1CEF915CF35C297C436B66E1D8BE6FC5FC359A873084D351874856CCC`
- Reference image 1: `tools/art/dice/reference/d6-brushed-metal-face-1.png`
- Reference image 2: `tools/art/dice/reference/d6-brushed-metal-face-4.png`
- Exact `referenced_image_paths` argument:

```json
[
  "tools/art/dice/reference/d6-brushed-metal-face-1.png",
  "tools/art/dice/reference/d6-brushed-metal-face-4.png"
]
```

Exact prompt:

```text
Use case: stylized-concept.
Asset type: one square metallic numbered dice-face PNG, D8 face 6.
Input images: Image 1 (d6-brushed-metal-face-1.png) and Image 2 (d6-brushed-metal-face-4.png) are the owner's original style references. Match their tile design, materials, lighting, frame and framing precisely; replace all circular pips with the specified numeral.
Primary request: Render exactly ONE face showing ONLY the numeral "6", optically centered. It must read as another face of the SAME SET as the supplied D6 images.
Tile: straight-on square dark charcoal brushed-metal tile with very fine horizontal brushing, small chamfered corners, the same thin beveled grey steel frame, fine inner edge, and exactly two small RED diagonal corner ticks, at top-left and bottom-right. Keep the outer tile square with only small clipped corners, never an octagon or a polyhedron outline. Match the references' soft upper-left illumination, restrained highlights and subtle depth.
Numeral: "6" in bold, clean, blocky sans-serif numerals, about 45% of the tile height. Use one large centered digit. The numeral itself is polished, slightly domed silver/steel, with softly curved reflective highlights matching the D6 pips, beveled edges and a thin dark recessed outline around its metal silhouette. It must look like raised polished metal set into the brushed tile, with subtle contact shadow, not printed ink. Include a short centered underline immediately below the numeral, made from the same polished domed metal with a thin dark recess, clearly indicating upright orientation.
Composition: one isolated face, front-on and upright, square image, whole tile visible, approximately 86% of canvas width and height, centered with transparent margin on every side matching the D6 framing. The tile interior is opaque. Outside the tile use actual PNG alpha transparency, not a checkerboard, white background, black rectangle, or backdrop.
Constraints: no pips, no other text, no die-type label, no logos, no Games Workshop or FUMBBL imagery, no copied published dice designs. No flat vector look, no pixel art, no cartoon outline, no white face, no extra ornamental details. Preserve the same reference tile appearance and keep the numeral highly readable.
```

## d8-face-7.png

- File: `tools/art/dice/masters/d8-face-7.png`
- SHA-256: `6E3C3377B39AAE40193A9C38390988707A0F3693C8CC72825E57A5189D7048DC`
- Reference image 1: `tools/art/dice/reference/d6-brushed-metal-face-1.png`
- Reference image 2: `tools/art/dice/reference/d6-brushed-metal-face-4.png`
- Exact `referenced_image_paths` argument:

```json
[
  "tools/art/dice/reference/d6-brushed-metal-face-1.png",
  "tools/art/dice/reference/d6-brushed-metal-face-4.png"
]
```

Exact prompt:

```text
Use case: stylized-concept.
Asset type: one square metallic numbered dice-face PNG, D8 face 7.
Input images: Image 1 (d6-brushed-metal-face-1.png) and Image 2 (d6-brushed-metal-face-4.png) are the owner's original style references. Match their tile design, materials, lighting, frame and framing precisely; replace all circular pips with the specified numeral.
Primary request: Render exactly ONE face showing ONLY the numeral "7", optically centered. It must read as another face of the SAME SET as the supplied D6 images.
Tile: straight-on square dark charcoal brushed-metal tile with very fine horizontal brushing, small chamfered corners, the same thin beveled grey steel frame, fine inner edge, and exactly two small RED diagonal corner ticks, at top-left and bottom-right. Keep the outer tile square with only small clipped corners, never an octagon or a polyhedron outline. Match the references' soft upper-left illumination, restrained highlights and subtle depth.
Numeral: "7" in bold, clean, blocky sans-serif numerals, about 45% of the tile height. Use one large centered digit. The numeral itself is polished, slightly domed silver/steel, with softly curved reflective highlights matching the D6 pips, beveled edges and a thin dark recessed outline around its metal silhouette. It must look like raised polished metal set into the brushed tile, with subtle contact shadow, not printed ink. Do not add an underline.
Composition: one isolated face, front-on and upright, square image, whole tile visible, approximately 86% of canvas width and height, centered with transparent margin on every side matching the D6 framing. The tile interior is opaque. Outside the tile use actual PNG alpha transparency, not a checkerboard, white background, black rectangle, or backdrop.
Constraints: no pips, no other text, no die-type label, no logos, no Games Workshop or FUMBBL imagery, no copied published dice designs. No flat vector look, no pixel art, no cartoon outline, no white face, no extra ornamental details. Preserve the same reference tile appearance and keep the numeral highly readable.
```

## d8-face-8.png

- File: `tools/art/dice/masters/d8-face-8.png`
- SHA-256: `3628E80A9A42A8F2CB1BF592553120AE241CB0DB9ECBF1602DE110CDA57899AE`
- Reference image 1: `tools/art/dice/reference/d6-brushed-metal-face-1.png`
- Reference image 2: `tools/art/dice/reference/d6-brushed-metal-face-4.png`
- Exact `referenced_image_paths` argument:

```json
[
  "tools/art/dice/reference/d6-brushed-metal-face-1.png",
  "tools/art/dice/reference/d6-brushed-metal-face-4.png"
]
```

Exact prompt:

```text
Use case: stylized-concept.
Asset type: one square metallic numbered dice-face PNG, D8 face 8.
Input images: Image 1 (d6-brushed-metal-face-1.png) and Image 2 (d6-brushed-metal-face-4.png) are the owner's original style references. Match their tile design, materials, lighting, frame and framing precisely; replace all circular pips with the specified numeral.
Primary request: Render exactly ONE face showing ONLY the numeral "8", optically centered. It must read as another face of the SAME SET as the supplied D6 images.
Tile: straight-on square dark charcoal brushed-metal tile with very fine horizontal brushing, small chamfered corners, the same thin beveled grey steel frame, fine inner edge, and exactly two small RED diagonal corner ticks, at top-left and bottom-right. Keep the outer tile square with only small clipped corners, never an octagon or a polyhedron outline. Match the references' soft upper-left illumination, restrained highlights and subtle depth.
Numeral: "8" in bold, clean, blocky sans-serif numerals, about 45% of the tile height. Use one large centered digit. The numeral itself is polished, slightly domed silver/steel, with softly curved reflective highlights matching the D6 pips, beveled edges and a thin dark recessed outline around its metal silhouette. It must look like raised polished metal set into the brushed tile, with subtle contact shadow, not printed ink. Do not add an underline.
Composition: one isolated face, front-on and upright, square image, whole tile visible, approximately 86% of canvas width and height, centered with transparent margin on every side matching the D6 framing. The tile interior is opaque. Outside the tile use actual PNG alpha transparency, not a checkerboard, white background, black rectangle, or backdrop.
Constraints: no pips, no other text, no die-type label, no logos, no Games Workshop or FUMBBL imagery, no copied published dice designs. No flat vector look, no pixel art, no cartoon outline, no white face, no extra ornamental details. Preserve the same reference tile appearance and keep the numeral highly readable.
```

## d16-face-1.png

- File: `tools/art/dice/masters/d16-face-1.png`
- SHA-256: `A766852A11563F353A89A4A1B6D743B112F7A53E66AF6B03572E9F4F183ABF63`
- Reference image 1: `tools/art/dice/reference/d6-brushed-metal-face-1.png`
- Reference image 2: `tools/art/dice/reference/d6-brushed-metal-face-4.png`
- Exact `referenced_image_paths` argument:

```json
[
  "tools/art/dice/reference/d6-brushed-metal-face-1.png",
  "tools/art/dice/reference/d6-brushed-metal-face-4.png"
]
```

Exact prompt:

```text
Use case: stylized-concept.
Asset type: one square metallic numbered dice-face PNG, D16 face 1.
Input images: Image 1 (d6-brushed-metal-face-1.png) and Image 2 (d6-brushed-metal-face-4.png) are the owner's original style references. Match their tile design, materials, lighting, frame and framing precisely; replace all circular pips with the specified numeral.
Primary request: Render exactly ONE face showing ONLY the numeral "1", optically centered. It must read as another face of the SAME SET as the supplied D6 images.
Tile: straight-on square dark charcoal brushed-metal tile with very fine horizontal brushing, small chamfered corners, the same thin beveled grey steel frame, fine inner edge, and exactly two small RED diagonal corner ticks, at top-left and bottom-right. Keep the outer tile square with only small clipped corners, never an octagon or a polyhedron outline. Match the references' soft upper-left illumination, restrained highlights and subtle depth.
Numeral: "1" in bold, clean, blocky sans-serif numerals, about 45% of the tile height. Use one large centered digit. The numeral itself is polished, slightly domed silver/steel, with softly curved reflective highlights matching the D6 pips, beveled edges and a thin dark recessed outline around its metal silhouette. It must look like raised polished metal set into the brushed tile, with subtle contact shadow, not printed ink. Do not add an underline.
Composition: one isolated face, front-on and upright, square image, whole tile visible, approximately 86% of canvas width and height, centered with transparent margin on every side matching the D6 framing. The tile interior is opaque. Outside the tile use actual PNG alpha transparency, not a checkerboard, white background, black rectangle, or backdrop.
Constraints: no pips, no other text, no die-type label, no logos, no Games Workshop or FUMBBL imagery, no copied published dice designs. No flat vector look, no pixel art, no cartoon outline, no white face, no extra ornamental details. Preserve the same reference tile appearance and keep the numeral highly readable.
```

## d16-face-2.png

- File: `tools/art/dice/masters/d16-face-2.png`
- SHA-256: `99E8D61609081CFA4275735F5FE3FA0C8DAB080FF7DA47ECAD3752D7644B2B32`
- Reference image 1: `tools/art/dice/reference/d6-brushed-metal-face-1.png`
- Reference image 2: `tools/art/dice/reference/d6-brushed-metal-face-4.png`
- Exact `referenced_image_paths` argument:

```json
[
  "tools/art/dice/reference/d6-brushed-metal-face-1.png",
  "tools/art/dice/reference/d6-brushed-metal-face-4.png"
]
```

Exact prompt:

```text
Use case: stylized-concept.
Asset type: one square metallic numbered dice-face PNG, D16 face 2.
Input images: Image 1 (d6-brushed-metal-face-1.png) and Image 2 (d6-brushed-metal-face-4.png) are the owner's original style references. Match their tile design, materials, lighting, frame and framing precisely; replace all circular pips with the specified numeral.
Primary request: Render exactly ONE face showing ONLY the numeral "2", optically centered. It must read as another face of the SAME SET as the supplied D6 images.
Tile: straight-on square dark charcoal brushed-metal tile with very fine horizontal brushing, small chamfered corners, the same thin beveled grey steel frame, fine inner edge, and exactly two small RED diagonal corner ticks, at top-left and bottom-right. Keep the outer tile square with only small clipped corners, never an octagon or a polyhedron outline. Match the references' soft upper-left illumination, restrained highlights and subtle depth.
Numeral: "2" in bold, clean, blocky sans-serif numerals, about 45% of the tile height. Use one large centered digit. The numeral itself is polished, slightly domed silver/steel, with softly curved reflective highlights matching the D6 pips, beveled edges and a thin dark recessed outline around its metal silhouette. It must look like raised polished metal set into the brushed tile, with subtle contact shadow, not printed ink. Do not add an underline.
Composition: one isolated face, front-on and upright, square image, whole tile visible, approximately 86% of canvas width and height, centered with transparent margin on every side matching the D6 framing. The tile interior is opaque. Outside the tile use actual PNG alpha transparency, not a checkerboard, white background, black rectangle, or backdrop.
Constraints: no pips, no other text, no die-type label, no logos, no Games Workshop or FUMBBL imagery, no copied published dice designs. No flat vector look, no pixel art, no cartoon outline, no white face, no extra ornamental details. Preserve the same reference tile appearance and keep the numeral highly readable.
```

## d16-face-3.png

- File: `tools/art/dice/masters/d16-face-3.png`
- SHA-256: `0AB5517D522E04DFA3572709D73F8FFD670C448A972C033542F566D747256B41`
- Reference image 1: `tools/art/dice/reference/d6-brushed-metal-face-1.png`
- Reference image 2: `tools/art/dice/reference/d6-brushed-metal-face-4.png`
- Exact `referenced_image_paths` argument:

```json
[
  "tools/art/dice/reference/d6-brushed-metal-face-1.png",
  "tools/art/dice/reference/d6-brushed-metal-face-4.png"
]
```

Exact prompt:

```text
Use case: stylized-concept.
Asset type: one square metallic numbered dice-face PNG, D16 face 3.
Input images: Image 1 (d6-brushed-metal-face-1.png) and Image 2 (d6-brushed-metal-face-4.png) are the owner's original style references. Match their tile design, materials, lighting, frame and framing precisely; replace all circular pips with the specified numeral.
Primary request: Render exactly ONE face showing ONLY the numeral "3", optically centered. It must read as another face of the SAME SET as the supplied D6 images.
Tile: straight-on square dark charcoal brushed-metal tile with very fine horizontal brushing, small chamfered corners, the same thin beveled grey steel frame, fine inner edge, and exactly two small RED diagonal corner ticks, at top-left and bottom-right. Keep the outer tile square with only small clipped corners, never an octagon or a polyhedron outline. Match the references' soft upper-left illumination, restrained highlights and subtle depth.
Numeral: "3" in bold, clean, blocky sans-serif numerals, about 45% of the tile height. Use one large centered digit. The numeral itself is polished, slightly domed silver/steel, with softly curved reflective highlights matching the D6 pips, beveled edges and a thin dark recessed outline around its metal silhouette. It must look like raised polished metal set into the brushed tile, with subtle contact shadow, not printed ink. Do not add an underline.
Composition: one isolated face, front-on and upright, square image, whole tile visible, approximately 86% of canvas width and height, centered with transparent margin on every side matching the D6 framing. The tile interior is opaque. Outside the tile use actual PNG alpha transparency, not a checkerboard, white background, black rectangle, or backdrop.
Constraints: no pips, no other text, no die-type label, no logos, no Games Workshop or FUMBBL imagery, no copied published dice designs. No flat vector look, no pixel art, no cartoon outline, no white face, no extra ornamental details. Preserve the same reference tile appearance and keep the numeral highly readable.
```

## d16-face-4.png

- File: `tools/art/dice/masters/d16-face-4.png`
- SHA-256: `A022F428A53DE780FFCE381AED33F02F32CA05140D0FAF8EB1C02EA9A2F281B3`
- Reference image 1: `tools/art/dice/reference/d6-brushed-metal-face-1.png`
- Reference image 2: `tools/art/dice/reference/d6-brushed-metal-face-4.png`
- Exact `referenced_image_paths` argument:

```json
[
  "tools/art/dice/reference/d6-brushed-metal-face-1.png",
  "tools/art/dice/reference/d6-brushed-metal-face-4.png"
]
```

Exact prompt:

```text
Use case: stylized-concept.
Asset type: one square metallic numbered dice-face PNG, D16 face 4.
Input images: Image 1 (d6-brushed-metal-face-1.png) and Image 2 (d6-brushed-metal-face-4.png) are the owner's original style references. Match their tile design, materials, lighting, frame and framing precisely; replace all circular pips with the specified numeral.
Primary request: Render exactly ONE face showing ONLY the numeral "4", optically centered. It must read as another face of the SAME SET as the supplied D6 images.
Tile: straight-on square dark charcoal brushed-metal tile with very fine horizontal brushing, small chamfered corners, the same thin beveled grey steel frame, fine inner edge, and exactly two small RED diagonal corner ticks, at top-left and bottom-right. Keep the outer tile square with only small clipped corners, never an octagon or a polyhedron outline. Match the references' soft upper-left illumination, restrained highlights and subtle depth.
Numeral: "4" in bold, clean, blocky sans-serif numerals, about 45% of the tile height. Use one large centered digit. The numeral itself is polished, slightly domed silver/steel, with softly curved reflective highlights matching the D6 pips, beveled edges and a thin dark recessed outline around its metal silhouette. It must look like raised polished metal set into the brushed tile, with subtle contact shadow, not printed ink. Do not add an underline.
Composition: one isolated face, front-on and upright, square image, whole tile visible, approximately 86% of canvas width and height, centered with transparent margin on every side matching the D6 framing. The tile interior is opaque. Outside the tile use actual PNG alpha transparency, not a checkerboard, white background, black rectangle, or backdrop.
Constraints: no pips, no other text, no die-type label, no logos, no Games Workshop or FUMBBL imagery, no copied published dice designs. No flat vector look, no pixel art, no cartoon outline, no white face, no extra ornamental details. Preserve the same reference tile appearance and keep the numeral highly readable.
```

## d16-face-5.png

- File: `tools/art/dice/masters/d16-face-5.png`
- SHA-256: `E57F1FFDC937C826082E4ED524588D6CCAFF738621083416F50AE6002710F604`
- Reference image 1: `tools/art/dice/reference/d6-brushed-metal-face-1.png`
- Reference image 2: `tools/art/dice/reference/d6-brushed-metal-face-4.png`
- Exact `referenced_image_paths` argument:

```json
[
  "tools/art/dice/reference/d6-brushed-metal-face-1.png",
  "tools/art/dice/reference/d6-brushed-metal-face-4.png"
]
```

Exact prompt:

```text
Use case: stylized-concept.
Asset type: one square metallic numbered dice-face PNG, D16 face 5.
Input images: Image 1 (d6-brushed-metal-face-1.png) and Image 2 (d6-brushed-metal-face-4.png) are the owner's original style references. Match their tile design, materials, lighting, frame and framing precisely; replace all circular pips with the specified numeral.
Primary request: Render exactly ONE face showing ONLY the numeral "5", optically centered. It must read as another face of the SAME SET as the supplied D6 images.
Tile: straight-on square dark charcoal brushed-metal tile with very fine horizontal brushing, small chamfered corners, the same thin beveled grey steel frame, fine inner edge, and exactly two small RED diagonal corner ticks, at top-left and bottom-right. Keep the outer tile square with only small clipped corners, never an octagon or a polyhedron outline. Match the references' soft upper-left illumination, restrained highlights and subtle depth.
Numeral: "5" in bold, clean, blocky sans-serif numerals, about 45% of the tile height. Use one large centered digit. The numeral itself is polished, slightly domed silver/steel, with softly curved reflective highlights matching the D6 pips, beveled edges and a thin dark recessed outline around its metal silhouette. It must look like raised polished metal set into the brushed tile, with subtle contact shadow, not printed ink. Do not add an underline.
Composition: one isolated face, front-on and upright, square image, whole tile visible, approximately 86% of canvas width and height, centered with transparent margin on every side matching the D6 framing. The tile interior is opaque. Outside the tile use actual PNG alpha transparency, not a checkerboard, white background, black rectangle, or backdrop.
Constraints: no pips, no other text, no die-type label, no logos, no Games Workshop or FUMBBL imagery, no copied published dice designs. No flat vector look, no pixel art, no cartoon outline, no white face, no extra ornamental details. Preserve the same reference tile appearance and keep the numeral highly readable.
```

## d16-face-6.png

- File: `tools/art/dice/masters/d16-face-6.png`
- SHA-256: `125EAF8B835A827D58F32ECC8B596CC0DD1FAE2D38A954921F84B1BF1DA0A79C`
- Reference image 1: `tools/art/dice/reference/d6-brushed-metal-face-1.png`
- Reference image 2: `tools/art/dice/reference/d6-brushed-metal-face-4.png`
- Exact `referenced_image_paths` argument:

```json
[
  "tools/art/dice/reference/d6-brushed-metal-face-1.png",
  "tools/art/dice/reference/d6-brushed-metal-face-4.png"
]
```

Exact prompt:

```text
Use case: stylized-concept.
Asset type: one square metallic numbered dice-face PNG, D16 face 6.
Input images: Image 1 (d6-brushed-metal-face-1.png) and Image 2 (d6-brushed-metal-face-4.png) are the owner's original style references. Match their tile design, materials, lighting, frame and framing precisely; replace all circular pips with the specified numeral.
Primary request: Render exactly ONE face showing ONLY the numeral "6", optically centered. It must read as another face of the SAME SET as the supplied D6 images.
Tile: straight-on square dark charcoal brushed-metal tile with very fine horizontal brushing, small chamfered corners, the same thin beveled grey steel frame, fine inner edge, and exactly two small RED diagonal corner ticks, at top-left and bottom-right. Keep the outer tile square with only small clipped corners, never an octagon or a polyhedron outline. Match the references' soft upper-left illumination, restrained highlights and subtle depth.
Numeral: "6" in bold, clean, blocky sans-serif numerals, about 45% of the tile height. Use one large centered digit. The numeral itself is polished, slightly domed silver/steel, with softly curved reflective highlights matching the D6 pips, beveled edges and a thin dark recessed outline around its metal silhouette. It must look like raised polished metal set into the brushed tile, with subtle contact shadow, not printed ink. Include a short centered underline immediately below the numeral, made from the same polished domed metal with a thin dark recess, clearly indicating upright orientation.
Composition: one isolated face, front-on and upright, square image, whole tile visible, approximately 86% of canvas width and height, centered with transparent margin on every side matching the D6 framing. The tile interior is opaque. Outside the tile use actual PNG alpha transparency, not a checkerboard, white background, black rectangle, or backdrop.
Constraints: no pips, no other text, no die-type label, no logos, no Games Workshop or FUMBBL imagery, no copied published dice designs. No flat vector look, no pixel art, no cartoon outline, no white face, no extra ornamental details. Preserve the same reference tile appearance and keep the numeral highly readable.
```

## d16-face-7.png

- File: `tools/art/dice/masters/d16-face-7.png`
- SHA-256: `AA8995A1E4BBBCB58F1FA4AF0113BC7505882A0D84965B7489FFFF5A57178C4C`
- Reference image 1: `tools/art/dice/reference/d6-brushed-metal-face-1.png`
- Reference image 2: `tools/art/dice/reference/d6-brushed-metal-face-4.png`
- Exact `referenced_image_paths` argument:

```json
[
  "tools/art/dice/reference/d6-brushed-metal-face-1.png",
  "tools/art/dice/reference/d6-brushed-metal-face-4.png"
]
```

Exact prompt:

```text
Use case: stylized-concept.
Asset type: one square metallic numbered dice-face PNG, D16 face 7.
Input images: Image 1 (d6-brushed-metal-face-1.png) and Image 2 (d6-brushed-metal-face-4.png) are the owner's original style references. Match their tile design, materials, lighting, frame and framing precisely; replace all circular pips with the specified numeral.
Primary request: Render exactly ONE face showing ONLY the numeral "7", optically centered. It must read as another face of the SAME SET as the supplied D6 images.
Tile: straight-on square dark charcoal brushed-metal tile with very fine horizontal brushing, small chamfered corners, the same thin beveled grey steel frame, fine inner edge, and exactly two small RED diagonal corner ticks, at top-left and bottom-right. Keep the outer tile square with only small clipped corners, never an octagon or a polyhedron outline. Match the references' soft upper-left illumination, restrained highlights and subtle depth.
Numeral: "7" in bold, clean, blocky sans-serif numerals, about 45% of the tile height. Use one large centered digit. The numeral itself is polished, slightly domed silver/steel, with softly curved reflective highlights matching the D6 pips, beveled edges and a thin dark recessed outline around its metal silhouette. It must look like raised polished metal set into the brushed tile, with subtle contact shadow, not printed ink. Do not add an underline.
Composition: one isolated face, front-on and upright, square image, whole tile visible, approximately 86% of canvas width and height, centered with transparent margin on every side matching the D6 framing. The tile interior is opaque. Outside the tile use actual PNG alpha transparency, not a checkerboard, white background, black rectangle, or backdrop.
Constraints: no pips, no other text, no die-type label, no logos, no Games Workshop or FUMBBL imagery, no copied published dice designs. No flat vector look, no pixel art, no cartoon outline, no white face, no extra ornamental details. Preserve the same reference tile appearance and keep the numeral highly readable.
```

## d16-face-8.png

- File: `tools/art/dice/masters/d16-face-8.png`
- SHA-256: `199842CA6033DF62C1D14239DF81E8BAC0648DFFFCA6112C7B4D1AED5A500DDD`
- Reference image 1: `tools/art/dice/reference/d6-brushed-metal-face-1.png`
- Reference image 2: `tools/art/dice/reference/d6-brushed-metal-face-4.png`
- Exact `referenced_image_paths` argument:

```json
[
  "tools/art/dice/reference/d6-brushed-metal-face-1.png",
  "tools/art/dice/reference/d6-brushed-metal-face-4.png"
]
```

Exact prompt:

```text
Use case: stylized-concept.
Asset type: one square metallic numbered dice-face PNG, D16 face 8.
Input images: Image 1 (d6-brushed-metal-face-1.png) and Image 2 (d6-brushed-metal-face-4.png) are the owner's original style references. Match their tile design, materials, lighting, frame and framing precisely; replace all circular pips with the specified numeral.
Primary request: Render exactly ONE face showing ONLY the numeral "8", optically centered. It must read as another face of the SAME SET as the supplied D6 images.
Tile: straight-on square dark charcoal brushed-metal tile with very fine horizontal brushing, small chamfered corners, the same thin beveled grey steel frame, fine inner edge, and exactly two small RED diagonal corner ticks, at top-left and bottom-right. Keep the outer tile square with only small clipped corners, never an octagon or a polyhedron outline. Match the references' soft upper-left illumination, restrained highlights and subtle depth.
Numeral: "8" in bold, clean, blocky sans-serif numerals, about 45% of the tile height. Use one large centered digit. The numeral itself is polished, slightly domed silver/steel, with softly curved reflective highlights matching the D6 pips, beveled edges and a thin dark recessed outline around its metal silhouette. It must look like raised polished metal set into the brushed tile, with subtle contact shadow, not printed ink. Do not add an underline.
Composition: one isolated face, front-on and upright, square image, whole tile visible, approximately 86% of canvas width and height, centered with transparent margin on every side matching the D6 framing. The tile interior is opaque. Outside the tile use actual PNG alpha transparency, not a checkerboard, white background, black rectangle, or backdrop.
Constraints: no pips, no other text, no die-type label, no logos, no Games Workshop or FUMBBL imagery, no copied published dice designs. No flat vector look, no pixel art, no cartoon outline, no white face, no extra ornamental details. Preserve the same reference tile appearance and keep the numeral highly readable.
```

## d16-face-9.png

- File: `tools/art/dice/masters/d16-face-9.png`
- SHA-256: `726295B8B92F18BD848B78EEFDCE9EED12CAE8C420E5FF324CC260AB96D29F36`
- Reference image 1: `tools/art/dice/reference/d6-brushed-metal-face-1.png`
- Reference image 2: `tools/art/dice/reference/d6-brushed-metal-face-4.png`
- Exact `referenced_image_paths` argument:

```json
[
  "tools/art/dice/reference/d6-brushed-metal-face-1.png",
  "tools/art/dice/reference/d6-brushed-metal-face-4.png"
]
```

Exact prompt:

```text
Use case: stylized-concept.
Asset type: one square metallic numbered dice-face PNG, D16 face 9.
Input images: Image 1 (d6-brushed-metal-face-1.png) and Image 2 (d6-brushed-metal-face-4.png) are the owner's original style references. Match their tile design, materials, lighting, frame and framing precisely; replace all circular pips with the specified numeral.
Primary request: Render exactly ONE face showing ONLY the numeral "9", optically centered. It must read as another face of the SAME SET as the supplied D6 images.
Tile: straight-on square dark charcoal brushed-metal tile with very fine horizontal brushing, small chamfered corners, the same thin beveled grey steel frame, fine inner edge, and exactly two small RED diagonal corner ticks, at top-left and bottom-right. Keep the outer tile square with only small clipped corners, never an octagon or a polyhedron outline. Match the references' soft upper-left illumination, restrained highlights and subtle depth.
Numeral: "9" in bold, clean, blocky sans-serif numerals, about 45% of the tile height. Use one large centered digit. The numeral itself is polished, slightly domed silver/steel, with softly curved reflective highlights matching the D6 pips, beveled edges and a thin dark recessed outline around its metal silhouette. It must look like raised polished metal set into the brushed tile, with subtle contact shadow, not printed ink. Include a short centered underline immediately below the numeral, made from the same polished domed metal with a thin dark recess, clearly indicating upright orientation.
Composition: one isolated face, front-on and upright, square image, whole tile visible, approximately 86% of canvas width and height, centered with transparent margin on every side matching the D6 framing. The tile interior is opaque. Outside the tile use actual PNG alpha transparency, not a checkerboard, white background, black rectangle, or backdrop.
Constraints: no pips, no other text, no die-type label, no logos, no Games Workshop or FUMBBL imagery, no copied published dice designs. No flat vector look, no pixel art, no cartoon outline, no white face, no extra ornamental details. Preserve the same reference tile appearance and keep the numeral highly readable.
```

## d16-face-10.png

- File: `tools/art/dice/masters/d16-face-10.png`
- SHA-256: `C284D31F34547BDCFD59C31778DE3A3E02B5EEDC0B4792E896FCC3B8289A652B`
- Reference image 1: `tools/art/dice/reference/d6-brushed-metal-face-1.png`
- Reference image 2: `tools/art/dice/reference/d6-brushed-metal-face-4.png`
- Exact `referenced_image_paths` argument:

```json
[
  "tools/art/dice/reference/d6-brushed-metal-face-1.png",
  "tools/art/dice/reference/d6-brushed-metal-face-4.png"
]
```

Exact prompt:

```text
Use case: stylized-concept.
Asset type: one square metallic numbered dice-face PNG, D16 face 10.
Input images: Image 1 (d6-brushed-metal-face-1.png) and Image 2 (d6-brushed-metal-face-4.png) are the owner's original style references. Match their tile design, materials, lighting, frame and framing precisely; replace all circular pips with the specified numeral.
Primary request: Render exactly ONE face showing ONLY the numeral "10", optically centered. It must read as another face of the SAME SET as the supplied D6 images.
Tile: straight-on square dark charcoal brushed-metal tile with very fine horizontal brushing, small chamfered corners, the same thin beveled grey steel frame, fine inner edge, and exactly two small RED diagonal corner ticks, at top-left and bottom-right. Keep the outer tile square with only small clipped corners, never an octagon or a polyhedron outline. Match the references' soft upper-left illumination, restrained highlights and subtle depth.
Numeral: "10" in bold, clean, blocky sans-serif numerals, about 45% of the tile height. Use moderately condensed digits with even narrow spacing so the two-digit numeral fits comfortably as one centered group. The numeral itself is polished, slightly domed silver/steel, with softly curved reflective highlights matching the D6 pips, beveled edges and a thin dark recessed outline around its metal silhouette. It must look like raised polished metal set into the brushed tile, with subtle contact shadow, not printed ink. Do not add an underline.
Composition: one isolated face, front-on and upright, square image, whole tile visible, approximately 86% of canvas width and height, centered with transparent margin on every side matching the D6 framing. The tile interior is opaque. Outside the tile use actual PNG alpha transparency, not a checkerboard, white background, black rectangle, or backdrop.
Constraints: no pips, no other text, no die-type label, no logos, no Games Workshop or FUMBBL imagery, no copied published dice designs. No flat vector look, no pixel art, no cartoon outline, no white face, no extra ornamental details. Preserve the same reference tile appearance and keep the numeral highly readable.
```

## d16-face-11.png

- File: `tools/art/dice/masters/d16-face-11.png`
- SHA-256: `3FEB715F9FF93380E3CF3299D924E422ED1C7A78A6B494E6B3DD3E2538F29676`
- Reference image 1: `tools/art/dice/reference/d6-brushed-metal-face-1.png`
- Reference image 2: `tools/art/dice/reference/d6-brushed-metal-face-4.png`
- Exact `referenced_image_paths` argument:

```json
[
  "tools/art/dice/reference/d6-brushed-metal-face-1.png",
  "tools/art/dice/reference/d6-brushed-metal-face-4.png"
]
```

Exact prompt:

```text
Use case: stylized-concept.
Asset type: one square metallic numbered dice-face PNG, D16 face 11.
Input images: Image 1 (d6-brushed-metal-face-1.png) and Image 2 (d6-brushed-metal-face-4.png) are the owner's original style references. Match their tile design, materials, lighting, frame and framing precisely; replace all circular pips with the specified numeral.
Primary request: Render exactly ONE face showing ONLY the numeral "11", optically centered. It must read as another face of the SAME SET as the supplied D6 images.
Tile: straight-on square dark charcoal brushed-metal tile with very fine horizontal brushing, small chamfered corners, the same thin beveled grey steel frame, fine inner edge, and exactly two small RED diagonal corner ticks, at top-left and bottom-right. Keep the outer tile square with only small clipped corners, never an octagon or a polyhedron outline. Match the references' soft upper-left illumination, restrained highlights and subtle depth.
Numeral: "11" in bold, clean, blocky sans-serif numerals, about 45% of the tile height. Use moderately condensed digits with even narrow spacing so the two-digit numeral fits comfortably as one centered group. The numeral itself is polished, slightly domed silver/steel, with softly curved reflective highlights matching the D6 pips, beveled edges and a thin dark recessed outline around its metal silhouette. It must look like raised polished metal set into the brushed tile, with subtle contact shadow, not printed ink. Do not add an underline.
Composition: one isolated face, front-on and upright, square image, whole tile visible, approximately 86% of canvas width and height, centered with transparent margin on every side matching the D6 framing. The tile interior is opaque. Outside the tile use actual PNG alpha transparency, not a checkerboard, white background, black rectangle, or backdrop.
Constraints: no pips, no other text, no die-type label, no logos, no Games Workshop or FUMBBL imagery, no copied published dice designs. No flat vector look, no pixel art, no cartoon outline, no white face, no extra ornamental details. Preserve the same reference tile appearance and keep the numeral highly readable.
```

## d16-face-12.png

- File: `tools/art/dice/masters/d16-face-12.png`
- SHA-256: `F7D85CB06356DECA2AFE2898F5597CBAC4A7CD1C31A54BEEA008AD3BA610ABAA`
- Reference image 1: `tools/art/dice/reference/d6-brushed-metal-face-1.png`
- Reference image 2: `tools/art/dice/reference/d6-brushed-metal-face-4.png`
- Exact `referenced_image_paths` argument:

```json
[
  "tools/art/dice/reference/d6-brushed-metal-face-1.png",
  "tools/art/dice/reference/d6-brushed-metal-face-4.png"
]
```

Exact prompt:

```text
Use case: stylized-concept.
Asset type: one square metallic numbered dice-face PNG, D16 face 12.
Input images: Image 1 (d6-brushed-metal-face-1.png) and Image 2 (d6-brushed-metal-face-4.png) are the owner's original style references. Match their tile design, materials, lighting, frame and framing precisely; replace all circular pips with the specified numeral.
Primary request: Render exactly ONE face showing ONLY the numeral "12", optically centered. It must read as another face of the SAME SET as the supplied D6 images.
Tile: straight-on square dark charcoal brushed-metal tile with very fine horizontal brushing, small chamfered corners, the same thin beveled grey steel frame, fine inner edge, and exactly two small RED diagonal corner ticks, at top-left and bottom-right. Keep the outer tile square with only small clipped corners, never an octagon or a polyhedron outline. Match the references' soft upper-left illumination, restrained highlights and subtle depth.
Numeral: "12" in bold, clean, blocky sans-serif numerals, about 45% of the tile height. Use moderately condensed digits with even narrow spacing so the two-digit numeral fits comfortably as one centered group. The numeral itself is polished, slightly domed silver/steel, with softly curved reflective highlights matching the D6 pips, beveled edges and a thin dark recessed outline around its metal silhouette. It must look like raised polished metal set into the brushed tile, with subtle contact shadow, not printed ink. Do not add an underline.
Composition: one isolated face, front-on and upright, square image, whole tile visible, approximately 86% of canvas width and height, centered with transparent margin on every side matching the D6 framing. The tile interior is opaque. Outside the tile use actual PNG alpha transparency, not a checkerboard, white background, black rectangle, or backdrop.
Constraints: no pips, no other text, no die-type label, no logos, no Games Workshop or FUMBBL imagery, no copied published dice designs. No flat vector look, no pixel art, no cartoon outline, no white face, no extra ornamental details. Preserve the same reference tile appearance and keep the numeral highly readable.
```

## d16-face-13.png

- File: `tools/art/dice/masters/d16-face-13.png`
- SHA-256: `485E2488BCC195F669B5807F3B2717F565A7FB7053EB3C8E4FF9C465AC36BD6F`
- Reference image 1: `tools/art/dice/reference/d6-brushed-metal-face-1.png`
- Reference image 2: `tools/art/dice/reference/d6-brushed-metal-face-4.png`
- Exact `referenced_image_paths` argument:

```json
[
  "tools/art/dice/reference/d6-brushed-metal-face-1.png",
  "tools/art/dice/reference/d6-brushed-metal-face-4.png"
]
```

Exact prompt:

```text
Use case: stylized-concept.
Asset type: one square metallic numbered dice-face PNG, D16 face 13.
Input images: Image 1 (d6-brushed-metal-face-1.png) and Image 2 (d6-brushed-metal-face-4.png) are the owner's original style references. Match their tile design, materials, lighting, frame and framing precisely; replace all circular pips with the specified numeral.
Primary request: Render exactly ONE face showing ONLY the numeral "13", optically centered. It must read as another face of the SAME SET as the supplied D6 images.
Tile: straight-on square dark charcoal brushed-metal tile with very fine horizontal brushing, small chamfered corners, the same thin beveled grey steel frame, fine inner edge, and exactly two small RED diagonal corner ticks, at top-left and bottom-right. Keep the outer tile square with only small clipped corners, never an octagon or a polyhedron outline. Match the references' soft upper-left illumination, restrained highlights and subtle depth.
Numeral: "13" in bold, clean, blocky sans-serif numerals, about 45% of the tile height. Use moderately condensed digits with even narrow spacing so the two-digit numeral fits comfortably as one centered group. The numeral itself is polished, slightly domed silver/steel, with softly curved reflective highlights matching the D6 pips, beveled edges and a thin dark recessed outline around its metal silhouette. It must look like raised polished metal set into the brushed tile, with subtle contact shadow, not printed ink. Do not add an underline.
Composition: one isolated face, front-on and upright, square image, whole tile visible, approximately 86% of canvas width and height, centered with transparent margin on every side matching the D6 framing. The tile interior is opaque. Outside the tile use actual PNG alpha transparency, not a checkerboard, white background, black rectangle, or backdrop.
Constraints: no pips, no other text, no die-type label, no logos, no Games Workshop or FUMBBL imagery, no copied published dice designs. No flat vector look, no pixel art, no cartoon outline, no white face, no extra ornamental details. Preserve the same reference tile appearance and keep the numeral highly readable.
```

## d16-face-14.png

- File: `tools/art/dice/masters/d16-face-14.png`
- SHA-256: `1C2DA690C4DDD64F9420843DE3985BB18DBAEF8127C7B72CAD401A239339D9EA`
- Reference image 1: `tools/art/dice/reference/d6-brushed-metal-face-1.png`
- Reference image 2: `tools/art/dice/reference/d6-brushed-metal-face-4.png`
- Exact `referenced_image_paths` argument:

```json
[
  "tools/art/dice/reference/d6-brushed-metal-face-1.png",
  "tools/art/dice/reference/d6-brushed-metal-face-4.png"
]
```

Exact prompt:

```text
Use case: stylized-concept.
Asset type: one square metallic numbered dice-face PNG, D16 face 14.
Input images: Image 1 (d6-brushed-metal-face-1.png) and Image 2 (d6-brushed-metal-face-4.png) are the owner's original style references. Match their tile design, materials, lighting, frame and framing precisely; replace all circular pips with the specified numeral.
Primary request: Render exactly ONE face showing ONLY the numeral "14", optically centered. It must read as another face of the SAME SET as the supplied D6 images.
Tile: straight-on square dark charcoal brushed-metal tile with very fine horizontal brushing, small chamfered corners, the same thin beveled grey steel frame, fine inner edge, and exactly two small RED diagonal corner ticks, at top-left and bottom-right. Keep the outer tile square with only small clipped corners, never an octagon or a polyhedron outline. Match the references' soft upper-left illumination, restrained highlights and subtle depth.
Numeral: "14" in bold, clean, blocky sans-serif numerals, about 45% of the tile height. Use moderately condensed digits with even narrow spacing so the two-digit numeral fits comfortably as one centered group. The numeral itself is polished, slightly domed silver/steel, with softly curved reflective highlights matching the D6 pips, beveled edges and a thin dark recessed outline around its metal silhouette. It must look like raised polished metal set into the brushed tile, with subtle contact shadow, not printed ink. Do not add an underline.
Composition: one isolated face, front-on and upright, square image, whole tile visible, approximately 86% of canvas width and height, centered with transparent margin on every side matching the D6 framing. The tile interior is opaque. Outside the tile use actual PNG alpha transparency, not a checkerboard, white background, black rectangle, or backdrop.
Constraints: no pips, no other text, no die-type label, no logos, no Games Workshop or FUMBBL imagery, no copied published dice designs. No flat vector look, no pixel art, no cartoon outline, no white face, no extra ornamental details. Preserve the same reference tile appearance and keep the numeral highly readable.
```

## d16-face-15.png

- File: `tools/art/dice/masters/d16-face-15.png`
- SHA-256: `75DCF6968257DB7907E7587397F0B3AA28FB6DCE881634F2CDE25FCD1A61EB50`
- Reference image 1: `tools/art/dice/reference/d6-brushed-metal-face-1.png`
- Reference image 2: `tools/art/dice/reference/d6-brushed-metal-face-4.png`
- Exact `referenced_image_paths` argument:

```json
[
  "tools/art/dice/reference/d6-brushed-metal-face-1.png",
  "tools/art/dice/reference/d6-brushed-metal-face-4.png"
]
```

Exact prompt:

```text
Use case: stylized-concept.
Asset type: one square metallic numbered dice-face PNG, D16 face 15.
Input images: Image 1 (d6-brushed-metal-face-1.png) and Image 2 (d6-brushed-metal-face-4.png) are the owner's original style references. Match their tile design, materials, lighting, frame and framing precisely; replace all circular pips with the specified numeral.
Primary request: Render exactly ONE face showing ONLY the numeral "15", optically centered. It must read as another face of the SAME SET as the supplied D6 images.
Tile: straight-on square dark charcoal brushed-metal tile with very fine horizontal brushing, small chamfered corners, the same thin beveled grey steel frame, fine inner edge, and exactly two small RED diagonal corner ticks, at top-left and bottom-right. Keep the outer tile square with only small clipped corners, never an octagon or a polyhedron outline. Match the references' soft upper-left illumination, restrained highlights and subtle depth.
Numeral: "15" in bold, clean, blocky sans-serif numerals, about 45% of the tile height. Use moderately condensed digits with even narrow spacing so the two-digit numeral fits comfortably as one centered group. The numeral itself is polished, slightly domed silver/steel, with softly curved reflective highlights matching the D6 pips, beveled edges and a thin dark recessed outline around its metal silhouette. It must look like raised polished metal set into the brushed tile, with subtle contact shadow, not printed ink. Do not add an underline.
Composition: one isolated face, front-on and upright, square image, whole tile visible, approximately 86% of canvas width and height, centered with transparent margin on every side matching the D6 framing. The tile interior is opaque. Outside the tile use actual PNG alpha transparency, not a checkerboard, white background, black rectangle, or backdrop.
Constraints: no pips, no other text, no die-type label, no logos, no Games Workshop or FUMBBL imagery, no copied published dice designs. No flat vector look, no pixel art, no cartoon outline, no white face, no extra ornamental details. Preserve the same reference tile appearance and keep the numeral highly readable.
```

## d16-face-16.png

- File: `tools/art/dice/masters/d16-face-16.png`
- SHA-256: `91420B89FE4078C5293FA3EAD9D073CDC97CCFBE6D64282BD66ED6557D5B55EE`
- Reference image 1: `tools/art/dice/reference/d6-brushed-metal-face-1.png`
- Reference image 2: `tools/art/dice/reference/d6-brushed-metal-face-4.png`
- Exact `referenced_image_paths` argument:

```json
[
  "tools/art/dice/reference/d6-brushed-metal-face-1.png",
  "tools/art/dice/reference/d6-brushed-metal-face-4.png"
]
```

Exact prompt:

```text
Use case: stylized-concept.
Asset type: one square metallic numbered dice-face PNG, D16 face 16.
Input images: Image 1 (d6-brushed-metal-face-1.png) and Image 2 (d6-brushed-metal-face-4.png) are the owner's original style references. Match their tile design, materials, lighting, frame and framing precisely; replace all circular pips with the specified numeral.
Primary request: Render exactly ONE face showing ONLY the numeral "16", optically centered. It must read as another face of the SAME SET as the supplied D6 images.
Tile: straight-on square dark charcoal brushed-metal tile with very fine horizontal brushing, small chamfered corners, the same thin beveled grey steel frame, fine inner edge, and exactly two small RED diagonal corner ticks, at top-left and bottom-right. Keep the outer tile square with only small clipped corners, never an octagon or a polyhedron outline. Match the references' soft upper-left illumination, restrained highlights and subtle depth.
Numeral: "16" in bold, clean, blocky sans-serif numerals, about 45% of the tile height. Use moderately condensed digits with even narrow spacing so the two-digit numeral fits comfortably as one centered group. The numeral itself is polished, slightly domed silver/steel, with softly curved reflective highlights matching the D6 pips, beveled edges and a thin dark recessed outline around its metal silhouette. It must look like raised polished metal set into the brushed tile, with subtle contact shadow, not printed ink. Do not add an underline.
Composition: one isolated face, front-on and upright, square image, whole tile visible, approximately 86% of canvas width and height, centered with transparent margin on every side matching the D6 framing. The tile interior is opaque. Outside the tile use actual PNG alpha transparency, not a checkerboard, white background, black rectangle, or backdrop.
Constraints: no pips, no other text, no die-type label, no logos, no Games Workshop or FUMBBL imagery, no copied published dice designs. No flat vector look, no pixel art, no cartoon outline, no white face, no extra ornamental details. Preserve the same reference tile appearance and keep the numeral highly readable.
```
