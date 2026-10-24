# SaveMe desktop interface

## Direction

Compact, minimal desktop utility, as explicitly chosen by the user. Content leads; neutral surfaces, thin separators, restrained accents. The existing large settings cards and nested boxes are replaced with a category rail and aligned settings rows.

## Identity

A bold white floppy disk on a solid Steam-blue circle (#1a9fff, sampled from the user's reference). Use that blue for primary controls, active navigation, links, focus and busy states; preserve separate success/warning/error colors. Use the same geometry for SVG, PNG, Windows ICO, and tray sizes. Distinct production and development AppUserModelIDs; only SaveMe-owned legacy shortcut collisions may be migrated.

## Layout

Slim persistent main navigation, a flat content canvas, compact page headers, and consistent 32px controls. Settings use a small local navigation and one category at a time; About is a quiet final category. Library rows keep recognizable artwork, readable game names and clear backup status. Long labels wrap without pushing controls outside the window.

## Verification

Check library, overview, detail, settings categories and minimum window size. Verify the actual Windows taskbar context menu, not only the executable's icon resource.

Windows shell icon paths include a content hash. Update both the window relaunch properties and the Start menu shortcut when artwork changes, so Explorer cannot reuse a cached previous color.

## Filled controls

Primary buttons and other solid interactive fills use #0b74bd with white text/icons; hover uses #0966a8. White-text contrast is 4.94:1 normally and 6.04:1 on hover. Keep the supplied Steam blue #1a9fff on the app icon, links, active navigation and focus indicators.
