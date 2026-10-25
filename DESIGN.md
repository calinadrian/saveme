# SaveMe desktop interface

## Direction

Compact, minimal desktop utility, as explicitly chosen by the user. Content leads; neutral surfaces, thin separators, restrained accents. The existing large settings cards and nested boxes are replaced with a category rail and aligned settings rows.

## Color balance and appearance

Use roughly 60% dominant neutral canvas, 30% secondary neutral structure, and 10% accent as a visual hierarchy, not a pixel quota. The five UI color families are neutral, blue, green, amber, and red; artwork and the brand icon are exempt. Playing uses neutral text and a play icon. All statuses carry labels or icons alongside color.

Settings → General → Appearance offers Dark, Light, and System. Dark remains the default for new and legacy profiles. System follows Windows changes live. A main-process controller coordinates native window colors and renderer tokens, with synchronous preload bootstrap before React renders. Failed preference writes retain the saved appearance.

Dark uses graphite surfaces; Light uses soft gray canvas, white surfaces, and dark ink. Steam blue #1a9fff remains the brand color; light-mode links use a darker blue for contrast. All component colors use semantic tokens, including alert ink, overlays, borders, switches, and destructive controls. Regular text and placeholders require 4.5:1 contrast on their composited backgrounds; meaningful controls and focus require 3:1. Check both themes, interaction states, zoom, and Windows forced colors.

## Identity

A bold white floppy disk on a solid Steam-blue circle (#1a9fff, sampled from the user's reference). Use that blue for primary controls, active navigation, links, focus and busy states; preserve separate success/warning/error colors. Use the same geometry for SVG, PNG, Windows ICO, and tray sizes. Distinct production and development AppUserModelIDs; only SaveMe-owned legacy shortcut collisions may be migrated.

## Sizing and type tokens

All sizes come from tokens at the top of `styles.css`; do not add literal font sizes or radii.

- Type scale: 12 (captions, chips), 13 (secondary text), 14 (body), 16 (card titles), 18 (section and dialog titles), 22 (page titles), 28 (stat values), 32 (onboarding headline).
- Controls: every button, input, select, search field and segmented control is 32px tall; small buttons inside rows and alerts are 28px. Radii: 6px for controls, 10px for cards, dialogs and alerts, full round for pills.
- Status colors in dark mode are saturated enough to read as color (green #4cc38a, amber #f0b54a, red #f47c84); all pass 4.5:1 on surfaces and pill tints. Alert messages use body text color; the tone shows in the border, tint and a leading icon that carries spoken "Warning:"/"Error:" text.
- Rows inside cards bleed into the card padding so covers and timeline dots line up with the card title. Library column headings and row content share a 12px inset.

## Layout

Slim persistent main navigation, a flat content canvas, compact page headers, and consistent 32px controls. Settings use a small local navigation and one category at a time; About is a quiet final category. Library rows keep recognizable artwork, readable game names and clear backup status. Long labels wrap without pushing controls outside the window.

## Verification

Check library, overview, detail, settings categories and minimum window size. Verify the actual Windows taskbar context menu, not only the executable's icon resource.

Windows shell icon paths include a content hash. Update both the window relaunch properties and the Start menu shortcut when artwork changes, so Explorer cannot reuse a cached previous color.

## Filled controls

Primary buttons and other solid interactive fills use #0b74bd with white text/icons; hover uses #0966a8. White-text contrast is 4.94:1 normally and 6.04:1 on hover. Keep the supplied Steam blue #1a9fff on the app icon, links, active navigation and focus indicators.

## Interaction and small windows

Library names and artwork form a keyboard-accessible details button; switches and recovery actions are separate controls. Returning from details preserves the library query, filter, scroll position, and focused game. Filters use pressed buttons and storage choices use native radio inputs.

Loading, unavailable, and confirmed-empty data have distinct labels. Forms retain failed entries and support Enter submission. Retention changes require explicit Apply changes; switches report pending, saved, and failed requests. Restore dialogs identify the selected version, its source, destination PC, and last confirmed local backup, with Cancel focused first.

Version history now uses one explicit backup-count draft (2–365) and Apply changes. New installations keep three backups per game; existing daily/weekly policies remain active until switched. Explain the newest-plus-previous count before applying it, confirm reductions, and show measured archive usage with separate loading and unavailable states.

Use the existing compact desktop rhythm at normal sizes. Below 700 CSS pixels, including app zoom, navigation becomes an icon rail and content stacks. Long paths and editor actions wrap. Preserve visible control focus, reduced-motion alternatives, and system colors in forced-color mode.
