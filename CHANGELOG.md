# Changelog

## [0.2.0](https://github.com/nicknisi/fleet/compare/v0.1.0...v0.2.0) (2026-05-27)


### Features

* add agent config with legacy backward compatibility ([4e33867](https://github.com/nicknisi/fleet/commit/4e3386710db65893d7c9c8493d78725851d4281d))
* add Claude Code hook scripts and plugin manifest ([688d5a9](https://github.com/nicknisi/fleet/commit/688d5a9a4133af7c1b57a96aa4a53524406a4a32))
* add CLI commands (status, next, send, install, doctor, reconcile) ([d402903](https://github.com/nicknisi/fleet/commit/d402903596a1a1bfee4f14721f3ad3e0c34de5d2))
* add entry point with CLI dispatch and TUI launch ([f6923df](https://github.com/nicknisi/fleet/commit/f6923dfccb8bb5b368e506f4b14cb49074f47bbe))
* add hook status file reader with file watcher ([39e6aae](https://github.com/nicknisi/fleet/commit/39e6aaeae5d8107fc4b3220a30efd2824d3637cf))
* add icon legend to footer ([fdf6f7b](https://github.com/nicknisi/fleet/commit/fdf6f7b2566f4743a6e8cb76f858b4748d193e16))
* add JSONL event log parser with status derivation ([e7a17e5](https://github.com/nicknisi/fleet/commit/e7a17e503eacc36f22b51e2bf2666826c781733d))
* add pane scraping for visual state detection ([ffec9e1](https://github.com/nicknisi/fleet/commit/ffec9e1020b9dcdd759f1bd0155f2fe3829ed475))
* add state types with priority ordering ([8233e3e](https://github.com/nicknisi/fleet/commit/8233e3e259add6417876c459463ed1d6fd102890))
* add terminal primitives (ansi, colors, mouse, input, terminal) ([8409926](https://github.com/nicknisi/fleet/commit/8409926f0eb3ae64fb7dbfe256825a3509504dc6))
* add three-layer state fusion engine ([94ab0d9](https://github.com/nicknisi/fleet/commit/94ab0d99f03e95a24eabe33ea73b209e7e2698e3))
* add tmux IPC layer (sessions, send-keys, port detection) ([a8a5424](https://github.com/nicknisi/fleet/commit/a8a5424380ef2963308a57090fb8bd8a378e4b1e))
* add TUI app state model with priority sorting ([661f77a](https://github.com/nicknisi/fleet/commit/661f77a032aecb0eb213f593c20e737822d49b96))
* add TUI renderer (dashboard, preview, send, help) ([5905e23](https://github.com/nicknisi/fleet/commit/5905e2301dff4228e2ee5ca407c3cb821f8a5acf))
* default preview on for wide terminals, --preview/--no-preview flags ([7fd63ea](https://github.com/nicknisi/fleet/commit/7fd63ea38d95f2ff1c60ec03506b69ac14b225c1))
* hide shell panes, remove separators, rainbow logo ([e5de37b](https://github.com/nicknisi/fleet/commit/e5de37b316f795e169fc638e4d2bd4dcf34048ed))


### Bug Fixes

* drop state labels, icon+color is enough ([49019a7](https://github.com/nicknisi/fleet/commit/49019a773843fca96a904d29c05f42c238a8b78d))
* eliminate render lag on navigation ([cf42bc3](https://github.com/nicknisi/fleet/commit/cf42bc33301648f5c5630e5faf5ccc450df3ad2a))
* filter mode and send mode input handling ([8b4d0ba](https://github.com/nicknisi/fleet/commit/8b4d0bac618ba626fcbd6857cd9cb5e36db6863c))
* formatting ([285ac8d](https://github.com/nicknisi/fleet/commit/285ac8d5f52892ef4551c3aa379496f5c76308b6))
* human-readable state labels (waiting/asking/done/working/idle) ([6aaca57](https://github.com/nicknisi/fleet/commit/6aaca5705008739b754b4e66f1528be90530c6d7))
* major perf overhaul + visual redesign ([93fc5da](https://github.com/nicknisi/fleet/commit/93fc5dac14fd0b3222b05c75ad8473f7fac4b3a8))
* move plugin manifest to .claude-plugin/ and fix install/doctor ([bed739a](https://github.com/nicknisi/fleet/commit/bed739a98ebcffe39efced3bf323ba4214c79af1))
* pause refresh timers during send/filter input ([7f6488f](https://github.com/nicknisi/fleet/commit/7f6488f99b747ff759b9cd46369d975b22dd9d8b))
* remove unused imports ([9536089](https://github.com/nicknisi/fleet/commit/95360898781e82aa2b8297ecedddd5011021c2e4))
* restore previous mode (e.g. preview) after send completes ([c217a1d](https://github.com/nicknisi/fleet/commit/c217a1d89083f4f8e3c0f6a453655e9b38403879))
* send mode skips to first sendable session, legend spacing ([ab62b35](https://github.com/nicknisi/fleet/commit/ab62b3501f26042e09a9a4c0a9a051c5cca1b9be))
