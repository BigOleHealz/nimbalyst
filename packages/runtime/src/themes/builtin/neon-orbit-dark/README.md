# Neon Orbit

A futuristic dark theme with midnight navy surfaces, electric blue actions, cyan focus indicators and violet accents. Matching palettes cover code blocks, tables, diffs and the terminal.

Select **Neon Orbit** in the navigation theme picker or **Settings > Themes** when running a build containing this theme. The existing theme discovery and packaging include the directory automatically.

The desktop chrome adds restrained gradients, illuminated navigation, outlined active tabs and rounded cards and composer fields. These styles are scoped to `neon-orbit-dark` in `packages/electron/src/renderer/styles/neon-orbit.css`; they disappear when another theme is selected. The palette can also be installed separately through the existing theme installation API, but the decorative chrome requires that stylesheet.

Normal, secondary and faint text meet a 4.5:1 contrast ratio against the theme's opaque surface and selection colors. White action labels meet 4.5:1 against both action gradient endpoints. Disabled text is deliberately quieter. The theme introduces no animation, font downloads or dependencies.
