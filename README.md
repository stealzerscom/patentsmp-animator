# PatentSMP Animator

A Blockbench-style 3D animation editor for the PatentSMP Minecraft server, running entirely in your browser.

**Open it:** https://stealzerscom.github.io/patentsmp-animator/

- **Body clips**: pose the real Minecraft player model (64×64 skin, outer layer, load any skin by username). Pivots, rotation order and limits are identical to the server's StealzersAnim body rig, so what you see is what plays in game.
- **Block rigs**: effects built from vanilla blocks and items that move, rotate and scale, with vanilla textures.
- Timeline with ticks (20 per second), keyframes per bone, drag to retime, copy/paste, easing per key, onion skin, undo/redo, autosave and multiple projects in the browser.
- Keyframe types: 40+ easing curves (sine, quad, cubic, quart, quint, expo, circ, back, elastic, bounce, each in/out/in-out), hold, instant and custom bezier curves;
  body bone scale, whole-body tilt (pitch/roll) and size; show/hide, brightness, glow, block/item swap and text keys (own rows under each part on the timeline);
  sound and particle events on the Events row. Key colours on the timeline show the curve family; property keys use their channel colour.

## Getting an animation into the game

1. Press **Send to Minecraft** and copy the code.
2. In game type just `/animator import`, click the box, **Ctrl+V**, press **Import**. (Typing `/animator import <code>` in chat only works for codes under ~240 characters: Minecraft cuts chat at 256.)
3. Press **Preview**.

To edit something that is already on the server: `/animator export <name>` in game, then **Paste code** here.

Codes are `PSMP1:` + base64url(raw deflate(JSON in the StealzersAnim format)).

No backend: everything is static. Skins come from mc-heads.net (fallback minotar.net, then Steve); block and item textures from assets.mcasset.cloud (fallback colours).

Third-party: three.js r160 (MIT), js-yaml 4.1.0 (MIT), Tabler Icons (MIT), Geist font (OFL). Licences in `vendor/`.
