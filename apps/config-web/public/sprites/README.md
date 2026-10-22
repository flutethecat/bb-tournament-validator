# Team-builder art: sprites

Idle portraits (home kit) cut from the Super FUMBBL walk sheets — the owner's original PixelLab art (packages/ffb-pitch/assets/walk on the desktop client). Column 0 of the 'S' row, cropped to the figure, native size; the page scales them with image-rendering: pixelated. manifest.json carries the per-race roles and the client's role-alias table for the resolver port in team-builder.js (Core.resolveSprite).

Source: wt-client-integration-o66aj `origin/order-66` @ facd5ca770ab45bf077c488da91e02219f0466f5 (read-only via git; see manifest.json `source`).
No FUMBBL CDN or mods/fumbbl-original-sprites art is used.

Regenerate (Python + Pillow, from the repo root):

    python -I apps/config-web/tools/build-builder-art.py --repo <path to the client checkout> --ref origin/order-66

Generated files — do not edit by hand.
