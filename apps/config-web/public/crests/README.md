# Team-builder art: crests

Team crests (home kit) from the Super FUMBBL desktop client (apps/tauri/src/assets/crests): the accepted PixelLab raster crests (home file of each home/away pair), PNG only; a race still on the SVG placeholder gets no crest. Keyed like teamCrests.ts crestKey (Core.resolveCrest).

Source: wt-client-integration-o66aj `origin/order-66` @ facd5ca770ab45bf077c488da91e02219f0466f5 (read-only via git; see manifest.json `source`).
No FUMBBL CDN or mods/fumbbl-original-sprites art is used.

Regenerate (Python + Pillow, from the repo root):

    python -I apps/config-web/tools/build-builder-art.py --repo <path to the client checkout> --ref origin/order-66

Generated files — do not edit by hand.
