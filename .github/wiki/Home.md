# Адаптер Pi для ядра harness

`@dnikulshin/pi-harness` превращает цикл `plan → code → gates → review → evaluate → decide` в одну
команду в сессии [Pi](https://pi.dev): `/cycle`. Адаптер потребляет контракт ядра
[`@dnikulshin/harness`](https://github.com/DNikulshin/dev-harness) — `bin`-команды и артефакты в
`.pi/artifacts/`, без импорта внутренностей.

## С чего начать

| Страница                              | Кому                                                           |
| ------------------------------------- | -------------------------------------------------------------- |
| [Установка](Install)                  | поставить адаптер в проект с ядром и проверить совместимость   |
| [Команды `/cycle`](Cycle-Commands)    | что делает каждая подкоманда и что показывает                  |
| [Совместимость версий](Compatibility) | диапазон ядра, отказ, расхождение версии шаблонов              |
| [FAQ](FAQ)                            | чем это отличается от workflows и от «просто попросить агента» |
| [Диагностика](Troubleshooting)        | типичные отказы, коды и куда смотреть                          |

## Что нужно знать сразу

- Адаптер **не** двигает стадии: стадиями управляет CLI ядра (`cycle-state`), адаптер показывает,
  исполняет детерминированные шаги и спрашивает подтверждение на переходах в `PR`/`ESCALATED`.
- Версия ядра сверяется с `peerDependencies` до первого шага: несовпадение — отказ с обоими
  номерами, а не падение на середине цикла.
- Артефакты только читаются: `/cycle state|gates|decision|evidence` ничего не пишут в
  `.pi/artifacts/`.

## Источники

- [README](https://github.com/DNikulshin/pi-harness#readme) — установка, команды, разработка;
- [AGENTS.md](https://github.com/DNikulshin/pi-harness/blob/main/AGENTS.md) — границы адаптера;
- [CHANGELOG.md](https://github.com/DNikulshin/pi-harness/blob/main/CHANGELOG.md) — версии;
- [README ядра](https://github.com/DNikulshin/dev-harness#readme) — протокол и артефакты.

Вики — вход, а не норматив: страницы правятся в репозитории (`.github/wiki/`) и публикуются
автоматически.
