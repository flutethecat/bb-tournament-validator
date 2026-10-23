# Recorder UI glyphs: icons/ui

Glyphs the tabletop recorder draws, copied from the Super FUMBBL desktop client by apps/config-web/tools/build-builder-art.py
(UI_ICONS from apps/tauri/src/assets/resources, UI_PITCH_ART from packages/ffb-pitch/assets: the same files the client's
graphical log draws), box-filtered to 64 px. Same fail-closed filters as the inducement icons (public-export.exclude and
byte-identity against fumbbl-assets). Regenerate only this set:

    python -I apps/config-web/tools/build-builder-art.py --only-ui --repo <path to the client checkout> --ref origin/order-66

Generated files - do not edit by hand.
