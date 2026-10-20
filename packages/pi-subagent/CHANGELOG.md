# Changelog

## [1.5.1](https://github.com/everyx/pi-extensions/compare/pi-subagent-v1.5.0...pi-subagent-v1.5.1) (2026-10-20)


### Bug Fixes

* **pi-subagent:** deliver completion reports as steering, not follow-ups ([fb06f47](https://github.com/everyx/pi-extensions/commit/fb06f4746185e1e39bc40c2b47ed7d88a05c2fd6))
* **pi-subagent:** state that the report arrives, not that the model must wait ([7e65fd3](https://github.com/everyx/pi-extensions/commit/7e65fd3161cf98ab130676ba360af711f100243d))

## [1.5.0](https://github.com/everyx/pi-extensions/compare/pi-subagent-v1.4.0...pi-subagent-v1.5.0) (2026-10-20)


### Features

* **pi-subagent:** continue a session instead of starting over ([347f76f](https://github.com/everyx/pi-extensions/commit/347f76fceda4cea494d85d55b3ab1fb2b3165a84))
* **pi-subagent:** every spawn returns immediately ([fb00a6c](https://github.com/everyx/pi-extensions/commit/fb00a6ccb7812ef22e1f5d525a10ac263575cc1a))


### Bug Fixes

* **pi-subagent:** make the drain rule independent of the TUI ([fb09d7d](https://github.com/everyx/pi-extensions/commit/fb09d7d957ceacb795f6d9192f3e2a6597ffa404))
* **pi-subagent:** one file for the copy the model reads, and a budget ([ca25e77](https://github.com/everyx/pi-extensions/commit/ca25e778b2d38dc1c2c3727a2e4a9a1e7339c63e))
* **pi-subagent:** stop a resident nested agent from spinning forever ([f534f93](https://github.com/everyx/pi-extensions/commit/f534f93f4c86f0ed338b9a30467b6e07eb7d2dd9))
* **pi-subagent:** stop an empty session file from resuming as a blank one ([801c8a2](https://github.com/everyx/pi-extensions/commit/801c8a225374cbfe92b08e91610834687813139e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @everyx/pi-ui bumped to 1.3.0

## [1.4.0](https://github.com/everyx/pi-extensions/compare/pi-subagent-v1.3.7...pi-subagent-v1.4.0) (2026-10-12)


### Features

* **pi-subagent:** show a queued report line until its card lands ([40398f2](https://github.com/everyx/pi-extensions/commit/40398f2980220cfaa52a3ed59519cb40ce5a3a83))


### Bug Fixes

* **pi-subagent:** launch the child pi through node on Windows ([fed362e](https://github.com/everyx/pi-extensions/commit/fed362e31c7a0e11dbe83f6c9685a64f6d47525a)), closes [#32](https://github.com/everyx/pi-extensions/issues/32)

## [1.3.7](https://github.com/everyx/pi-extensions/compare/pi-subagent-v1.3.6...pi-subagent-v1.3.7) (2026-09-11)


### Bug Fixes

* **pi-subagent:** cascade widget-row removal down the spawn subtree ([ebe4f59](https://github.com/everyx/pi-extensions/commit/ebe4f59b4123d44788c22c09ba122cd7216fa476))
* **pi-subagent:** route a woken agent's output to the widget ([092f793](https://github.com/everyx/pi-extensions/commit/092f793a97d139d51eff7f1de91692ceebc2e362))
* **pi-subagent:** stop the completion card reading as a spawn ([a6cf5c4](https://github.com/everyx/pi-extensions/commit/a6cf5c40eb8bf9c9362c7fe549a773c59ee4a5a1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @everyx/pi-ui bumped to 1.2.0

## [1.3.6](https://github.com/everyx/pi-extensions/compare/pi-subagent-v1.3.5...pi-subagent-v1.3.6) (2026-09-01)


### Bug Fixes

* **pi-subagent:** agent_spawn title → required label — short, single name end-to-end ([963d04f](https://github.com/everyx/pi-extensions/commit/963d04f483003a31cb07702272a0f679456c56df))
* **pi-subagent:** persistent foreground widget row registers as idle, not done ([8499866](https://github.com/everyx/pi-extensions/commit/849986608ea3e380d1e2e8bbb492f0c3a361f47f))
* **pi-subagent:** rot sweep — dead PI_SUBAGENT_PARENT + steer leftovers, stale docs/SPEC, files += README.zh.md ([f2ef35f](https://github.com/everyx/pi-extensions/commit/f2ef35fecfc6af9b5feae653766d72ceb7c71cc1))
* single-source the display surface — counterParts, agentTitle, iconForStatus ([d698d29](https://github.com/everyx/pi-extensions/commit/d698d29b42d6af27fb445cd39353ed749fb45c7c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @everyx/pi-ui bumped to 1.1.2

## [1.3.5](https://github.com/everyx/pi-extensions/compare/pi-subagent-v1.3.4...pi-subagent-v1.3.5) (2026-08-31)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @everyx/pi-ui bumped to 1.1.1

## [1.3.4](https://github.com/everyx/pi-extensions/compare/pi-subagent-v1.3.3...pi-subagent-v1.3.4) (2026-08-31)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @everyx/pi-ui bumped to 1.1.0

## [1.3.3](https://github.com/everyx/pi-extensions/compare/pi-subagent-v1.3.2...pi-subagent-v1.3.3) (2026-08-30)


### Bug Fixes

* correct display bugs an LLM reader would trust ([3ee8501](https://github.com/everyx/pi-extensions/commit/3ee8501e304468864f359e017d9008643530ffa9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @everyx/pi-ui bumped to 1.0.3

## [1.3.2](https://github.com/everyx/pi-extensions/compare/pi-subagent-v1.3.1...pi-subagent-v1.3.2) (2026-08-29)


### Bug Fixes

* **release:** migrate to release-please for correct workspace/catalog resolution ([e3b51e4](https://github.com/everyx/pi-extensions/commit/e3b51e421d7679f7c00739646f97d770dd0ff2aa))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @everyx/pi-ui bumped to 1.0.2
