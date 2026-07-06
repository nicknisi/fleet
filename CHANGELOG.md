# Changelog

## [0.14.0](https://github.com/nicknisi/fleet/compare/v0.13.0...v0.14.0) (2026-07-06)


### Features

* harness-agnostic awareness — spinner-glyph detection, hook-less discovery, silent notifications ([#29](https://github.com/nicknisi/fleet/issues/29)) ([c6b3c08](https://github.com/nicknisi/fleet/commit/c6b3c082f41e62042f2035aa4b4c20cbf4387523))

## [0.13.0](https://github.com/nicknisi/fleet/compare/v0.12.0...v0.13.0) (2026-07-05)


### Features

* double-click a sidebar row to jump to that agent ([#27](https://github.com/nicknisi/fleet/issues/27)) ([8fca9df](https://github.com/nicknisi/fleet/commit/8fca9df0352208698f0f200652db8662592e2b1d))

## [0.12.0](https://github.com/nicknisi/fleet/compare/v0.11.0...v0.12.0) (2026-07-04)


### Features

* agent-awareness polish — explain, detection manifests, Codex, wait, window rollup, labels/rename ([#25](https://github.com/nicknisi/fleet/issues/25)) ([3e6cd36](https://github.com/nicknisi/fleet/commit/3e6cd365ba458a156eb359e7b80b9040aee91106))

## [0.11.0](https://github.com/nicknisi/fleet/compare/v0.10.1...v0.11.0) (2026-07-03)


### Features

* make fleet sidebar span the full window height ([#23](https://github.com/nicknisi/fleet/issues/23)) ([c1e7988](https://github.com/nicknisi/fleet/commit/c1e79887d0ae9c69f022751a6e289a693a311865))

## [0.10.1](https://github.com/nicknisi/fleet/compare/v0.10.0...v0.10.1) (2026-07-03)


### Bug Fixes

* replace dangling marketplace symlink on install ([#21](https://github.com/nicknisi/fleet/issues/21)) ([c476d55](https://github.com/nicknisi/fleet/commit/c476d55c7de7c250c477aa454fd644f08e12629b))

## [0.10.0](https://github.com/nicknisi/fleet/compare/v0.9.0...v0.10.0) (2026-07-03)


### Features

* adaptive theming, responsive sidebar layout, and UI polish ([#19](https://github.com/nicknisi/fleet/issues/19)) ([9f513aa](https://github.com/nicknisi/fleet/commit/9f513aa51a6f62edb9b930e800bac701428714b9))

## [0.9.0](https://github.com/nicknisi/fleet/compare/v0.8.0...v0.9.0) (2026-06-23)


### Features

* clear an agent's notification when you focus its pane ([#17](https://github.com/nicknisi/fleet/issues/17)) ([e0974e0](https://github.com/nicknisi/fleet/commit/e0974e08f50926e01dc63652dfa7e24285d559e1))


### Bug Fixes

* make tmux status line legible on light terminal themes ([#15](https://github.com/nicknisi/fleet/issues/15)) ([4273536](https://github.com/nicknisi/fleet/commit/42735361c8cb694c0c7cd77b905087eeaa51c836))

## [0.8.0](https://github.com/nicknisi/fleet/compare/v0.7.0...v0.8.0) (2026-06-10)


### Features

* group dashboard rows by session and label agents by window ([#13](https://github.com/nicknisi/fleet/issues/13)) ([b404541](https://github.com/nicknisi/fleet/commit/b40454116adff5f00761de8af938cffb2cd9ebdf))

## [0.7.0](https://github.com/nicknisi/fleet/compare/v0.6.1...v0.7.0) (2026-06-10)


### Features

* show tmux window in agent names ([#11](https://github.com/nicknisi/fleet/issues/11)) ([03f9df6](https://github.com/nicknisi/fleet/commit/03f9df6ecc1af8794f1904769b3918bb9a76c307))

## [0.6.1](https://github.com/nicknisi/fleet/compare/v0.6.0...v0.6.1) (2026-06-10)


### Bug Fixes

* ship plugin hooks in homebrew package and fail loudly on hookless install ([#9](https://github.com/nicknisi/fleet/issues/9)) ([48458eb](https://github.com/nicknisi/fleet/commit/48458eb65a7cac03ba41b052230491ddd5f201ed))

## [0.6.0](https://github.com/nicknisi/fleet/compare/v0.5.1...v0.6.0) (2026-06-09)


### Features

* clear/mark-read statusline notifications ([#7](https://github.com/nicknisi/fleet/issues/7)) ([ea0aab7](https://github.com/nicknisi/fleet/commit/ea0aab783a096cca1d45e86c90168c1e86bdc677))

## [0.5.1](https://github.com/nicknisi/fleet/compare/v0.5.0...v0.5.1) (2026-05-29)


### Bug Fixes

* seal preview pane ANSI so diff backgrounds don't bleed into list ([040bdc4](https://github.com/nicknisi/fleet/commit/040bdc4a00ea6e6d55b46607e751f18399104fb0))

## [0.5.0](https://github.com/nicknisi/fleet/compare/v0.4.0...v0.5.0) (2026-05-28)


### Features

* acknowledge ready agents on statusline click too ([fda4715](https://github.com/nicknisi/fleet/commit/fda47154bd829a18ce4600d645cbc9472a76b804))
* honest ready/asking states ([9725fff](https://github.com/nicknisi/fleet/commit/9725fff1fc028469e9e78190a9b08f522b2bfea8))
* kill sessions from the dashboard with x ([7eb2641](https://github.com/nicknisi/fleet/commit/7eb26417fe8a6d780d9f6c6e7e598c34b0b952a0))
* ready is a green dot and shows in the statusline ([b3d8ffa](https://github.com/nicknisi/fleet/commit/b3d8ffa06f827e0e958f39af3c50ae0b65eea8d5))
* sort working above ready in the dashboard ([de924d7](https://github.com/nicknisi/fleet/commit/de924d72cdec1c8a7ecbeae1d9dec1daecadc954))
* switching to a ready agent acknowledges it ([baefdaf](https://github.com/nicknisi/fleet/commit/baefdaf7c990e78e6e9a6644a95557e43fbf4868))


### Bug Fixes

* acknowledgement actually clears agents (anchor on status file) ([95501c0](https://github.com/nicknisi/fleet/commit/95501c0c2ea83b342a6942b115289ab4147da285))
* ready state never auto-decays to idle ([e65f192](https://github.com/nicknisi/fleet/commit/e65f192f27574abcc4109500640592ab536f923c))
* stop the scraper from demoting DONE to IDLE ([ef346b4](https://github.com/nicknisi/fleet/commit/ef346b45c699d985f3c535071035fa7ceda2246c))

## [0.4.0](https://github.com/nicknisi/fleet/compare/v0.3.0...v0.4.0) (2026-05-28)


### Features

* add fleet status --statusline for multi-agent tmux row ([93df94a](https://github.com/nicknisi/fleet/commit/93df94a2ac02df992d7386a235908d771e8bd304))
* add fleet statusline --inject/--remove ([4ae5568](https://github.com/nicknisi/fleet/commit/4ae556873af99f6abcf99f7a656125fa0b20fe9a))
* add whimsy to --help with rainbow logo, quips, and state legend ([db4e795](https://github.com/nicknisi/fleet/commit/db4e7952d47136a6c1535745843c4b7287e9803b))
* draggable split divider between session list and preview ([c9ce7fe](https://github.com/nicknisi/fleet/commit/c9ce7fec68b52337c6f4abb2f6c51d209f4e9490))
* make fleet statusline entries clickable in tmux ([6764dda](https://github.com/nicknisi/fleet/commit/6764ddaff1c699f531b631818eaf1c10b481654d))
* manage tmux.conf integration during fleet install/uninstall ([afec36f](https://github.com/nicknisi/fleet/commit/afec36fdcb069534ba861e810307fb911118c54e))
* show Claude session name in detail column ([74c376c](https://github.com/nicknisi/fleet/commit/74c376cafabff0523c443b309f150e1faa26f690))
* status line shows only PERMIT and QUESTION ([38ddce0](https://github.com/nicknisi/fleet/commit/38ddce028c280e329e08cfc0285a7b03943762eb))
* wire layer 3 pane scraping into refresh loop ([6821ae0](https://github.com/nicknisi/fleet/commit/6821ae08c37c79e8dd43e4303e0c9c6005675242))


### Bug Fixes

* decay stale PERMIT/QUESTION states after 10 minutes ([ff6b313](https://github.com/nicknisi/fleet/commit/ff6b313450c05d6040e57b135ad5ae2efc9c7e55))
* distinguish permit/question/done states in hooks and engine ([b64400b](https://github.com/nicknisi/fleet/commit/b64400b1b5612359588e5fa07cfd52b6d8eb1b6e))
* notification hook read wrong field, never wrote permit/question/done ([2b02856](https://github.com/nicknisi/fleet/commit/2b02856afcb1179df065fd98a460d66b6cb781ac))
* plugin symlink pointed to / in compiled binary, drag mode unused ([e58720a](https://github.com/nicknisi/fleet/commit/e58720ac9d0f534b4620bb4eb55e77a5411e04eb))
* preserve default window-click behavior on top status row ([451d83f](https://github.com/nicknisi/fleet/commit/451d83f37cfe9f3e9fbed2c8cfa7d414c0c9e2f1))
* scraper IDLE no longer overrides live BUSY; detect Claude's spinner ([004ba09](https://github.com/nicknisi/fleet/commit/004ba09b8289abe4c872672ae392f5e10de1e684))
* scraper overrides all stale states, not just PERMIT ([424b574](https://github.com/nicknisi/fleet/commit/424b57426386c3cdcc5f5c4b8b808c95bb1a4250))
* scraper returns IDLE for prompt, QUESTION for AskUserQuestion ([af2f416](https://github.com/nicknisi/fleet/commit/af2f416d48ec4c2bdb30610389bf20358043fd7a))
* use MouseDown1Status instead of invalid Status key name ([7117a7f](https://github.com/nicknisi/fleet/commit/7117a7f634f8a24413b7af5c9e95fcb4e5a44621))
* verify pane state on switch instead of using timeouts ([12ceac1](https://github.com/nicknisi/fleet/commit/12ceac1d55623906da63ecd128c439ca11eee6d1))

## [0.3.0](https://github.com/nicknisi/fleet/compare/v0.2.0...v0.3.0) (2026-05-28)


### Features

* add passthrough mode and quick actions to preview pane ([9eea934](https://github.com/nicknisi/fleet/commit/9eea9343849e8ac7d0dd49db0db3700f69109542))

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
