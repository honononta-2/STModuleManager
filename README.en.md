# Module Management Tool for Star Resonance

[![GitHub Release](https://img.shields.io/github/v/release/honononta-2/STModuleManager)](https://github.com/honononta-2/STModuleManager/releases/latest)
[![GitHub Downloads](https://img.shields.io/github/downloads/honononta-2/STModuleManager/total)](https://github.com/honononta-2/STModuleManager/releases)

**An unofficial tool for managing and optimizing modules in [Blue Protocol: Star Resonance](https://bpsr.xdg.com/jp/).**

[日本語](README.md) | [한국어](README.ko.md)

> [!NOTE]
> The desktop app (Tauri version) supports English. You can switch the language from the menu button in the top-left → **Language**.
> The Web version does not currently support English.

> [!WARNING]
> This tool has no affiliation with the game's official operators.
> The developer assumes no responsibility for any issues arising from its use.
> **Use entirely at your own risk.**

## Web Version

**[Open Web Version](https://st-module-manager.pages.dev/)** (mobile-friendly)

You can import modules via OCR from screenshots and run optimization — no packet capture required, usable from any device.

> [!WARNING]
> The Web version does not currently support English. The interface is displayed in Japanese.

> [!TIP]
> Importing too many screenshots at once may crash the browser. Import a few at a time.

## Features

- Automatic module data retrieval via packet capture
- Module list display, filtering, and sorting
- Optimization to automatically find the best 4-module combination
- JSON / CSV export

## Download

Download the latest `StarResonanceModuleTool-vX.X.X.zip` from the [Releases](../../releases) page and extract it to any folder. No installation required.

### System Requirements

- Windows 10 / 11
- Administrator privileges (required for packet capture)

> [!NOTE]
> This tool uses [WinDivert](https://reqrypt.org/windivert.html) for packet capture, which may trigger false positives in Windows Defender or other antivirus software. If this occurs, add the folder to your exclusion list.

## How to Use

### Retrieving Module Data

1. **Open Star Resonance** — Log in to the game
2. **Launch this tool** — Double-click `STModuleManager.exe` (administrator privileges will be requested automatically)
3. **Turn on Network Monitoring** — Click the "Network Monitoring" toggle in the status bar at the bottom of the screen
4. **Move to a different area in Star Resonance** — Switch scenes via map travel or teleportation

When the toggle is turned on, "Searching for server..." will be displayed, and it will change to "Server connected" once the game server is found. Turn off the toggle when data retrieval is not needed.

Module data is retrieved from communication during area transitions. To update your data after obtaining new modules, keep the tool running and move to a different area again.

### Module List & Sorting

Sorting by individual stat values is not available in-game, but this tool supports sorting by acquisition date/time, total value, and more. Combined with filtering, you can quickly find the module you're looking for.

※ Acquisition date/time records when this tool captured the module, not in-game data.

### Optimization

1. Open the "Optimize" panel from the tabs at the top of the screen
2. Select **Main Stat** (required) — the stat you want to reach +20
3. Select **Sub Stats** (optional) — stats you'd like to boost if possible
4. Set **Excluded Stats** and rarity filters as needed
5. Run to display the top 10 combinations by score

Frequently used settings can be saved and recalled with a name using "Save Pattern".

## Optimization Algorithm

### Overview

From your available modules (up to ~2000), the tool finds the combination of 4 that maximizes **breakpoint attainment** and **total stat values** for the specified stats.

### Breakpoints

The effect of a stat increases in stages based on its total value across 4 modules (max +20).

| Total | Effect |
|-------|--------|
| +1 | Activated |
| +4 | Increased |
| +8 | Increased |
| +12 | Increased |
| +16 | Greatly increased |
| +20 | Maximum |

### Score Calculation

Points are added based on the highest breakpoint reached for each stat.

| Breakpoint | Main (× 1.0) | Sub (× 0.3) | Unselected (× 0.15) | Excluded |
|-----------|--------------|-------------|---------------------|---------|
| +20 reached | 10,000 pt | 3,000 pt | 1,500 pt | 0 |
| +16 reached | 5,000 pt | 1,500 pt | 750 pt | 0 |
| +12 reached | 100 pt | 30 pt | 15 pt | 0 |
| +8 reached | 50 pt | 15 pt | 7.5 pt | 0 |
| +4 reached | 20 pt | 6 pt | 3 pt | 0 |
| +1 reached | 5 pt | 1.5 pt | 0.75 pt | 0 |

In addition, **total + values across all stats × 2** is added to the score.

> **Priority:** +20 reached > +16 reached > total + values > +12 or lower breakpoints
>
> By setting the point values for +20 / +16 sufficiently higher than the theoretical maximum of the + value bonus, breakpoint attainment is always prioritized.

### Search Optimization

Exhaustively searching C(2000, 4) ≈ 66 billion combinations is impractical, so the following filtering steps are applied:

1. **Relevance filter** — Exclude modules with no main/sub stats
2. **Rarity filter** — Exclude modules below the specified quality
3. **Contribution Score Top N** — Narrow down to top 300 modules by contribution score (`Σ(main value × 3) + Σ(sub value × 1) + Σ(other value × 0.5)`)

After filtering, the pool is reduced to roughly 150–300 modules. Combined with **multi-core parallel search** via Rayon and **branch pruning** (cutting off when the optimistic upper-bound score — adding +20 to remaining stats after choosing 2 — falls below the current best), the search runs within a practical time on CPU.

## License

The code in this repository may be freely used, modified, and redistributed. No attribution required. However, selling it for profit is prohibited.

Copyrights for in-game images and assets included in this tool belong to the game company.

Bug reports, requests, and inquiries: please use [Issues](../../issues).
