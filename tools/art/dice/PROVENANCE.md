# Dice face provenance

The match recorder's dice roller (apps/config-web, `spa/src/dice`) draws these faces. Owner call (2026-11-03): use the
Super FUMBBL client's own dice art; only the D8 and D16 faces are new.

## D6 and block die: the Super FUMBBL client's default dice (owner's own art)

- Source repository: the Super FUMBBL client (`fumbbl40k-client`), branch `order-66` at commit **04a3d8fbe** (client
  1.0.301). Bytes were read with `git show origin/order-66:<path>`, never from a working tree or an older commit.
- D6: the client's DEFAULT face variant (`DEFAULT_D6_FACE_VARIANT = 'brushed-metal'`, `packages/ffb-pitch/src/d6.ts`).
- Block die: the client's DEFAULT block-face family (not the KrisB "Rick dice" set, which is not used here). These are
  the owner's own art: they replaced the FUMBBL originals in place on 2026-09-02 (client commit bdf603ba4, "Replace block
  dice with result cards"), with the gold POW! / Stumble! edits of 2026-09-08 (e346f8aa2, 7d25ba9f0). None of the
  FUMBBL originals is in this repository.
- Served as 128 x 128 copies, downscaled with Windows System.Drawing (high-quality bicubic, alpha kept); renamed for the
  block faces as listed. The full-size D6 faces are kept in `reference/` as the style source for the D8 / D16 faces, with
  the default POW! face (`reference/block-face-pow.png`).

| Source (client, order-66 @ 04a3d8fbe) | SHA-256 |
| --- | --- |
| `packages/ffb-pitch/assets/d6/d6-brushed-metal-face-1.png` | `107a73435201845889e6204a1e3270fc39d98e190b208e7dc5c6e5568a0d3299` |
| `packages/ffb-pitch/assets/d6/d6-brushed-metal-face-2.png` | `445ddd385d4111154d44619d364a2e04544e64d6cd4c5d837a31fc1af2c08aa2` |
| `packages/ffb-pitch/assets/d6/d6-brushed-metal-face-3.png` | `aee8df3f93684c34529185e648647a2b80ca3689a57f5050be4fde0404601dd1` |
| `packages/ffb-pitch/assets/d6/d6-brushed-metal-face-4.png` | `557a98f11224b19971c6abc4eb246040afa2cd8e75eb6276d6b9f62cbf0b5b14` |
| `packages/ffb-pitch/assets/d6/d6-brushed-metal-face-5.png` | `61353e0f86427fb62c0178776efbfeb4ec715678f95221b26d88bbf4d87f641b` |
| `packages/ffb-pitch/assets/d6/d6-brushed-metal-face-6.png` | `2a0cc8cc5efb2544fe8a15ba0f98607fbfb504bbed47d8de9f4f0c08fa6d667e` |

| Source (client, order-66 @ 04a3d8fbe) | Served as (`public/assets/dice/block/128/`) | SHA-256 of the source |
| --- | --- | --- |
| `packages/ffb-pitch/assets/blockdice/face_skull.png` | `block-face-skull.png` | `f401132f13ff63b44a86258cb4e3c038a711c6f3d27bf61714667f91d0aa7948` |
| `packages/ffb-pitch/assets/blockdice/face_bothdown.png` | `block-face-both-down.png` | `51b4b3056a527b49166f200012a8a38e2ea343902428278309263da10bfcdb9b` |
| `packages/ffb-pitch/assets/blockdice/face_push.png` | `block-face-push.png` | `f5950daad008be9f92e1914d96c6a918971141ae3f70075f9209d9af41f852d8` |
| `packages/ffb-pitch/assets/blockdice/face_powpush.png` | `block-face-stumble.png` | `20556350134b1e1fd3b4146e5205d27c614b7ef0ad0b1ce4ed0f744ec7203b4b` |
| `packages/ffb-pitch/assets/blockdice/face_pow.png` | `block-face-pow.png` | `5667df7cc4b37151adc4ada64299c0e8842f455926815cdfb4641178284f6e2d` |

## D8 and D16: made to match the client's brushed-metal D6 (Codex image generation, 2026-11-03)

- Creator: Codex image generation (`codex exec --enable image_generation`, CLI 0.164.0), one call per face, 24 calls.
- Style input: the brushed-metal D6 references above (two per call, listed per face in `PROMPTS-d8-d16.md`). No other
  image input; no third-party, Games Workshop or FUMBBL imagery; nothing traced from published dice.
- Each face is the brushed-metal tile (frame, red corner ticks, brushing, lighting) with a raised polished-steel numeral
  in the pips' material; 6 and 9 are underlined. Masters are 512 x 512 in `masters/`; the served 128 px copies are
  bicubic downscales.
- Exact prompts, the references passed and the masters' checksums: `PROMPTS-d8-d16.md`.

## Files in this repository

| File | SHA-256 |
| --- | --- |
| `tools/art/dice/reference/block-face-pow.png` | `5667df7cc4b37151adc4ada64299c0e8842f455926815cdfb4641178284f6e2d` |
| `tools/art/dice/reference/d6-brushed-metal-face-1.png` | `107a73435201845889e6204a1e3270fc39d98e190b208e7dc5c6e5568a0d3299` |
| `tools/art/dice/reference/d6-brushed-metal-face-2.png` | `445ddd385d4111154d44619d364a2e04544e64d6cd4c5d837a31fc1af2c08aa2` |
| `tools/art/dice/reference/d6-brushed-metal-face-3.png` | `aee8df3f93684c34529185e648647a2b80ca3689a57f5050be4fde0404601dd1` |
| `tools/art/dice/reference/d6-brushed-metal-face-4.png` | `557a98f11224b19971c6abc4eb246040afa2cd8e75eb6276d6b9f62cbf0b5b14` |
| `tools/art/dice/reference/d6-brushed-metal-face-5.png` | `61353e0f86427fb62c0178776efbfeb4ec715678f95221b26d88bbf4d87f641b` |
| `tools/art/dice/reference/d6-brushed-metal-face-6.png` | `2a0cc8cc5efb2544fe8a15ba0f98607fbfb504bbed47d8de9f4f0c08fa6d667e` |
| `tools/art/dice/masters/d16-face-1.png` | `a766852a11563f353a89a4a1b6d743b112f7a53e66af6b03572e9f4f183abf63` |
| `tools/art/dice/masters/d16-face-10.png` | `c284d31f34547bdcfd59c31778de3a3e02b5eedc0b4792e896fcc3b8289a652b` |
| `tools/art/dice/masters/d16-face-11.png` | `3feb715f9ff93380e3cf3299d924e422ed1c7a78a6b494e6b3dd3e2538f29676` |
| `tools/art/dice/masters/d16-face-12.png` | `f7d85cb06356deca2afe2898f5597cbac4a7cd1c31a54beea008ad3ba610abaa` |
| `tools/art/dice/masters/d16-face-13.png` | `485e2488bcc195f669b5807f3b2717f565a7fb7053eb3c8e4ff9c465ac36bd6f` |
| `tools/art/dice/masters/d16-face-14.png` | `1c2da690c4ddd64f9420843de3985bb18dbaef8127c7b72cad401a239339d9ea` |
| `tools/art/dice/masters/d16-face-15.png` | `75dcf6968257db7907e7587397f0b3aa28fb6dce881634f2cde25fcd1a61eb50` |
| `tools/art/dice/masters/d16-face-16.png` | `91420b89fe4078c5293fa3ead9d073cdc97ccfbe6d64282bd66ed6557d5b55ee` |
| `tools/art/dice/masters/d16-face-2.png` | `99e8d61609081cfa4275735f5fe3fa0c8dab080ff7da47ecad3752d7644b2b32` |
| `tools/art/dice/masters/d16-face-3.png` | `0ab5517d522e04dfa3572709d73f8ffd670c448a972c033542f566d747256b41` |
| `tools/art/dice/masters/d16-face-4.png` | `a022f428a53de780ffce381aed33f02f32ca05140d0faf8eb1c02ea9a2f281b3` |
| `tools/art/dice/masters/d16-face-5.png` | `e57f1ffdc937c826082e4ed524588d6ccaff738621083416f50ae6002710f604` |
| `tools/art/dice/masters/d16-face-6.png` | `125eaf8b835a827d58f32ecc8b596cc0dd1fae2d38a954921f84b1bf1da0a79c` |
| `tools/art/dice/masters/d16-face-7.png` | `aa8995a1e4bbbcb58f1fa4af0113bc7505882a0d84965b7489ffff5a57178c4c` |
| `tools/art/dice/masters/d16-face-8.png` | `199842ca6033df62c1d14239df81e8bac0648dfffca6112c7b4d1aed5a500ddd` |
| `tools/art/dice/masters/d16-face-9.png` | `726295b8b92f18bd848b78eefdce9eed12cae8c420e5ff324cc260ab96d29f36` |
| `tools/art/dice/masters/d8-face-1.png` | `e92a9f276d27ff2f2462de1d03635de775e1d046328f0003b36661058031efed` |
| `tools/art/dice/masters/d8-face-2.png` | `6eaa1fb0b5e3b6a16b2c7a855739e819789b471ca811487f927cdb799b46a7ad` |
| `tools/art/dice/masters/d8-face-3.png` | `9ef7e86744f32e895ba3ab9d9f8d68d36f6674bd1a8befef8a78a94ff1349151` |
| `tools/art/dice/masters/d8-face-4.png` | `a68ac3b4012df86e434397a995053f146232665f4249b3820a8822a352341fd1` |
| `tools/art/dice/masters/d8-face-5.png` | `a579bb2b16312daa308d29c68edb09aec6e8331d85f1a9e864a67d266af8d7d7` |
| `tools/art/dice/masters/d8-face-6.png` | `d84bcde1cef915cf35c297c436b66e1d8be6fc5fc359a873084d351874856ccc` |
| `tools/art/dice/masters/d8-face-7.png` | `6e3c3377b39aae40193a9c38390988707a0f3693c8cc72825e57a5189d7048dc` |
| `tools/art/dice/masters/d8-face-8.png` | `3628e80a9a42a8f2cb1bf592553120ae241cb0db9ecbf1602de110cda57899ae` |
| `apps/config-web/public/assets/dice/block/128/block-face-both-down.png` | `3b2f47b466e000ac1ac5431226afe22d2e888dc35cb5c8c1537f7ff8c226c1b5` |
| `apps/config-web/public/assets/dice/block/128/block-face-pow.png` | `12a7821b770a6e70504bef5a00e6ba0c278d18058a3065b663e6800699b9adce` |
| `apps/config-web/public/assets/dice/block/128/block-face-push.png` | `e5a133f7523b840ee628c6b8268a24ae3a24ce65ae591d07af1d209ad0535174` |
| `apps/config-web/public/assets/dice/block/128/block-face-skull.png` | `245b450b19174e328631259504d4138f1cdaf82ecb0f6f5cf9d257b2638fba76` |
| `apps/config-web/public/assets/dice/block/128/block-face-stumble.png` | `c057ea36a55f610f3b7873d41151551bc61c49c6e8cb9ad8e4947f35adf31c45` |
| `apps/config-web/public/assets/dice/d16/128/d16-face-1.png` | `08e8ebf109981d4b0021fb4f18cc39fdda7fb00d26ee0875ffa975e38f8be3b5` |
| `apps/config-web/public/assets/dice/d16/128/d16-face-10.png` | `6fad68f73bf2e9379b4f5284aee33b6b08eb3120b603c33f0c890ef879d18d7e` |
| `apps/config-web/public/assets/dice/d16/128/d16-face-11.png` | `2bdb46181139573b2a821ee740cb0c711f4d03eaff9ff2b4caad8d97b739fa5b` |
| `apps/config-web/public/assets/dice/d16/128/d16-face-12.png` | `fcad158ccf22857591befa9947895f20d93f17224bef17bec58e32374d5d3006` |
| `apps/config-web/public/assets/dice/d16/128/d16-face-13.png` | `eb318caee3aa813a0bfdddb53a785bcca00bae8c7435509eefa0e47b20b8088f` |
| `apps/config-web/public/assets/dice/d16/128/d16-face-14.png` | `6acc00527f13c6d32a9e33dbb18e1c76f37f7d2719c2268a2dd642fcdf0117c3` |
| `apps/config-web/public/assets/dice/d16/128/d16-face-15.png` | `f7893890ab8e15a18fd0bfc4f5c9eefd0b5032b7f22a692b4819b74649cd940f` |
| `apps/config-web/public/assets/dice/d16/128/d16-face-16.png` | `c78951235d1ebc34343ce1d359ef098f71e513a70653c2017f218d2788f29990` |
| `apps/config-web/public/assets/dice/d16/128/d16-face-2.png` | `6d2fc7dcead025efd422fa5bba099b2d9d24865c7bc15a503346b95a33262936` |
| `apps/config-web/public/assets/dice/d16/128/d16-face-3.png` | `ffbc1ad2809236005f40d7409c1efd0fbbd8b7c172e776e8056c7409a9f06b4d` |
| `apps/config-web/public/assets/dice/d16/128/d16-face-4.png` | `201ad30f6034c5fa9e2f69db6812534c891f68a58fdf8ced9cf8e3c6fe794413` |
| `apps/config-web/public/assets/dice/d16/128/d16-face-5.png` | `25c0a70f048359e1073a8abc1e3152b6c2a8a59a30a75687763d40ae5c96e393` |
| `apps/config-web/public/assets/dice/d16/128/d16-face-6.png` | `b515545ff40de2a079c2e6a14572897e7d6f641b1c2800debf1f568539399314` |
| `apps/config-web/public/assets/dice/d16/128/d16-face-7.png` | `6565b1bf4037b41c10dddc70feffd8a8162ed9156cbe0fc45b4e9e5aaf9cbeae` |
| `apps/config-web/public/assets/dice/d16/128/d16-face-8.png` | `095609330d6d9a23a4b09c33147ccb725906ff9da75af05ecc52f9d209775ca1` |
| `apps/config-web/public/assets/dice/d16/128/d16-face-9.png` | `5725a0831eafe7821ba88b03c0bc941c46329bf18904601c6961bdadfd055a77` |
| `apps/config-web/public/assets/dice/d6/128/d6-face-1.png` | `b1a1c74049c2a664ff158c7ee64bd9bf5edc98181b472dda44cc4d7bd83a79f4` |
| `apps/config-web/public/assets/dice/d6/128/d6-face-2.png` | `c444aaa32045a5be0fbe5cd4fcf3eaa2ce4851ef3cb50d77a581364c1d7a99dc` |
| `apps/config-web/public/assets/dice/d6/128/d6-face-3.png` | `920cbd37d544b983e16827d3b606735a720ce32c9546f3f062f82bb3c986dc4a` |
| `apps/config-web/public/assets/dice/d6/128/d6-face-4.png` | `b3efb160157746cc533003c929ae13b0348c4ea1e37e514dd1e1fef285874eda` |
| `apps/config-web/public/assets/dice/d6/128/d6-face-5.png` | `999229aa4a0ae683b9a2a2376c03ad55a2e498de7101d224f54f7bcfbda68a88` |
| `apps/config-web/public/assets/dice/d6/128/d6-face-6.png` | `99672434579836d1e77948c7e1f55ff3116a72651b6d8d3e5d4391138f769b13` |
| `apps/config-web/public/assets/dice/d8/128/d8-face-1.png` | `c683d341ce2f418c7b31fc0ba6a91b6537ee603d3e01d8fd90544927b7441c27` |
| `apps/config-web/public/assets/dice/d8/128/d8-face-2.png` | `59c062d681415c1e2523f30f2d6b69566fca357a55f733fda23316cee11ba831` |
| `apps/config-web/public/assets/dice/d8/128/d8-face-3.png` | `4e4f4d28d31e1cdf00a47570248846489f1231518dc1d28893e6a5d554ef7db2` |
| `apps/config-web/public/assets/dice/d8/128/d8-face-4.png` | `1c1deb4d044b45229ca9c915e63700395a771141b18c1c8bafe73f223ede495c` |
| `apps/config-web/public/assets/dice/d8/128/d8-face-5.png` | `bebfdd59c9298a9a9133f4a15542a484de58ece615780a40dd6dfba4b0ad6314` |
| `apps/config-web/public/assets/dice/d8/128/d8-face-6.png` | `a8301ec3b95a2f40b373fff3e92b0f1995aed332689a60584f2f7ac93e7d7508` |
| `apps/config-web/public/assets/dice/d8/128/d8-face-7.png` | `e471379ffbbccbea461d87191fe964d0a0da4e5d250a1640e7aabf34294abd17` |
| `apps/config-web/public/assets/dice/d8/128/d8-face-8.png` | `7dfa44512ddf0bf50253dcec8f32af4961afc1607603f536476bd5aa2af9f515` |
