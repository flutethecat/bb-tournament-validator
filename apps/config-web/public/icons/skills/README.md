# Team-builder art: icons/skills

Skill icons from the Super FUMBBL desktop client's "Illustrated - Default" family (packages/ffb-pitch/assets/skill-badges-illustrated — owner-original, Codex-generated, 174 BB2025 keys), box-filtered from the 128 px masters to 40 px and shown smoothed at ~17 px. File name = the client's canonical key (skillIcons.ts: lower-case a-z0-9, then skillIconAliases.json, carried in manifest.json as `aliases`); the builder strips a display parameter ("Hatred (Troll)", "Loner (4+)") and roster asterisks first (Core.skillIconKey).

Source: wt-client-integration-o66aj `origin/order-66` @ facd5ca770ab45bf077c488da91e02219f0466f5 (read-only via git; see manifest.json `source`).
No FUMBBL CDN or mods/fumbbl-original-sprites art is used.

Regenerate (Python + Pillow, from the repo root):

    python -I apps/config-web/tools/build-builder-art.py --repo <path to the client checkout> --ref origin/order-66

Generated files — do not edit by hand.
