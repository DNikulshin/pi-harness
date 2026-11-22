# @dnikulshin/pi-harness

[![CI](https://github.com/DNikulshin/pi-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/DNikulshin/pi-harness/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@dnikulshin/pi-harness)](https://www.npmjs.com/package/@dnikulshin/pi-harness)
[![Node](https://img.shields.io/badge/node-%3E%3D26.13%20%3C27-informational)](./.nvmrc)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

Адаптер [Pi](https://pi.dev) для ядра
[`@dnikulshin/harness`](https://github.com/DNikulshin/dev-harness): цикл
`plan → code → gates → review → evaluate → decide` одной командой, без ручных вызовов скриптов ядра.

**Статус:** цикл ведётся — `/cycle next`, `/cycle run` и показ артефактов (`state`, `gates`,
`decision`, `evidence`). То, что требует модели или человека (`plan`, `code`, `review`, `evaluate`,
коммиты, PR), драйвер отдаёт как `spawn`/`handoff` — адаптер на этом останавливается, а не играет
роль супервизора.

## Установка

```bash
# в проекте, где уже стоит ядро
npm i -D @dnikulshin/harness
pi install npm:@dnikulshin/pi-harness
```

Дальше — `/cycle` в сессии Pi.

## Команды

```bash
/cycle next     # что делать прямо сейчас: стадия, шаг, ожидание, готовая команда
/cycle run      # исполнить детерминированные шаги до первой остановки
/cycle state    # состояние цикла: стадия, шаг, итерация, чего ждём
/cycle gates [n]     # гейты итерации: что прошло, код возврата, первые строки вывода
/cycle decision [n]  # решение итерации: действие, причина, куда возврат
/cycle evidence [путь] # файлы пакета оценщика с размерами; путь — показать содержимое
/cycle help     # подсказка по подкомандам
```

`/cycle next` ничего не меняет: читает `state.json` и артефакты через `cycle-driver next` и
показывает шаг (`action`, `target`, причина, чего цикл ждёт, что уже сделано, какая команда
следующая).

`/cycle run` исполняет шаги, которые ядро считает детерминированными (`run`, `advance`, `finish`), и
**останавливается** на `spawn`, `handoff`, `stop`, `blocked` — там работу делает человек или другая
сессия, и «доиграть» её нельзя. Перед исполнением перехода в `PR` или `ESCALATED` адаптер спрашивает
подтверждение: отказ оставляет цикл на месте, ничего не исполняя.

Перед любой командой проверяется совместимость: установленная версия ядра
(`node_modules/@dnikulshin/harness/package.json`) сверяется с `peerDependencies` этого пакета
(`^0.2.0`). Версия вне диапазона — отказ с обоими номерами, цикл не начинается. Расхождение версии
ядра и версии шаблонов (`.pi/harness.version`) — предупреждение.

`/cycle state`, `/cycle gates`, `/cycle decision` и `/cycle evidence` показывают артефакты цикла из
`.pi/artifacts/**`: `state.json`, `gates.<n>.json` (плюс первые строки логов `gates/<id>.<n>.log`),
`decision.<n>.json` и пакет `evidence/` с размерами файлов. Номер итерации по умолчанию — текущий из
`state.json`. Вывод ограничен по объёму: полный лог гейта и больше 32 КБ `evidence/` в TUI не
уезжают. Всё это **только чтение**: адаптер не правит артефакты и не двигает стадии — это делает CLI
ядра (`cycle-state`), и это проверяется тестом по исходникам и по снимку каталога.

Проверка доступна и без интерактивной сессии — это же и есть контракт для CI потребителя:

```bash
npx pi-harness-check          # 0 — совместимо, 1 — не установлено или вне диапазона
```

## Чем это отличается от `pi-extension-workflows` и от «просто попросить агента»

|                           | `pi-extension-workflows`                | `/cycle` (этот пакет)                                                          | «Просто попросить агента»    |
| ------------------------- | --------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------- |
| Что задаёт                | произвольный повторяемый сценарий шагов | протокол цикла: стадии, замороженные критерии, `evidence/`, машинное решение   | ничего, кроме текста запроса |
| Кто решает о переходе     | человек или модель                      | правило ядра (`cycle-decide`) + подтверждение владельца там, где оно требуется | модель                       |
| Что остаётся после задачи | лог шагов                               | артефакты задачи (`state.json`, `gates.<n>.json`, `decision.<n>.json`)         | переписка в сессии           |
| Чем проверяется           | самим сценарием                         | гейтами проекта (код возврата) и отчётом                                       | ничем                        |

Одной фразой: workflows — «повтори последовательность», `/cycle` — «доведи задачу до решения,
которое можно проверить». Они не конкурируют: сценарий может вызывать `/cycle` как шаг.

## Требования

- Node.js 26.13.x (`engines.node` = `>=26.13 <27`), Linux или macOS;
- ядро `@dnikulshin/harness` `^0.2.0` в проекте;
- Pi `>=1.6.0`.

## Разработка

```bash
npm test              # node --test: 156 тестов без сети
npm run test:e2e      # сквозной прогон на ядре из реестра (~2 с, нужна сеть)
npm run typecheck     # tsc --noEmit (JS + JSDoc, strict)
npm run check         # тесты + типы + prettier
```

`test:e2e` поднимает настоящий проект потребителя: `npm i -D @dnikulshin/harness` из реестра,
`harness-init`, `cycle-state init` в git-репозитории с веткой `main`, затем живой `next` и `run` до
первой остановки. Версия ядра закреплена в `devDependencies` — отдельного пина нет; ночной прогон
(`nightly-e2e.yml`) берёт `latest` и падает первым, если контракт в ядре поехал.

Внутренности ядра не импортируются — это проверяет `test/imports.test.mjs`.

## Документация и участие

- [`AGENTS.md`](./AGENTS.md) — границы адаптера: что потребляем, что не имеем права делать.
- [`CHANGELOG.md`](./CHANGELOG.md) — история версий (`0.1.x`, `0.2.x`) и что считается ломающим.
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — issue → ветка → PR, проверки, границы правки.
- [`SECURITY.md`](./SECURITY.md) — приватное сообщение об уязвимости и что уязвимостью не считается.
- [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) — кодекс поведения участников.
- [Вики](https://github.com/DNikulshin/pi-harness/wiki) — вход для нового пользователя: `/cycle` по
  шагам, разбор отказов, FAQ по совместимости версий.
- Контракт ядра, который потребляется:
  [README ядра](https://github.com/DNikulshin/dev-harness#readme) и Приложение A
  `docs/orchestrator-core.md`.

## Лицензия

MIT.
