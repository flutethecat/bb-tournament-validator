# Team-builder art: icons/inducements

Inducement icons from the Super FUMBBL desktop client (apps/tauri/src/assets/resources, original UI icons cleared for public use 09-02; mapping = coachPanelChips.ts INDUCEMENT_ICONS by fork inducement type), box-filtered to 64 px. Inducements with no icon are listed under noIcon and get a placeholder tile. Upstream FUMBBL art (fumbbl-assets/, block_skull, coin_skull) is never copied.

Source: wt-client-integration-o66aj `origin/order-66` @ facd5ca770ab45bf077c488da91e02219f0466f5 (read-only via git; see manifest.json `source`).
No FUMBBL CDN or mods/fumbbl-original-sprites art is used.

Regenerate (Python + Pillow, from the repo root):

    python -I apps/config-web/tools/build-builder-art.py --repo <path to the client checkout> --ref origin/order-66

Generated files — do not edit by hand.
