# Team Captain badges

Ready for integration review. Two approved-for-handoff visual variants: gold and steel grey. Both are a battered athletic C with metal spikes and rivets, for marking a team captain in tournament builders.

## Files

- masters/: original 1254 x 1254 PNGs.
- 24/, 32/, 48/, 64/, 128/, 256/: square PNG exports in both colors.
- assets-manifest.json: file inventory, dimensions and transparency checks.

## Integration

Use these assets for the Team Captain marker. Preserve aspect ratio and alpha; do not add a rectangular background. Match surrounding control sizing, usually 24 or 32 CSS pixels. For crisp high-density display, use the 48 or 64 pixel export respectively. Give a standalone marker the accessible label and tooltip 'Team captain'; if adjacent text already conveys that meaning, mark the image decorative.

Gold and grey are visual options only: no selected/disabled state, rank or permission distinction was specified. Follow the existing tournament builder state model. Do not change captain assignment behavior based on asset color.

Review on light and dark UI backgrounds and at the actual display size. The gold version has been visually inspected at 32 pixels. All packaged PNGs were checked for alpha transparency and dimensions. This package contains assets only; no client integration or commit was performed.

## Reproduction

Gold: chunky hockey-style captain C; battered warm gold, ivory highlights, charcoal outline, silver rivets and two restrained spikes on the left. Wide open counter, strong small-size silhouette, transparent background.
Grey: recolor the gold reference to neutral grey steel with silver-white highlights and charcoal bevels; preserve the C, spikes, rivets and weathering. Preserve transparency.
