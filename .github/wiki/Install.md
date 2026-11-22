# Установка

## Что нужно

- проект, в котором уже стоит ядро: `npm i -D @dnikulshin/harness` (или `pnpm add -D`);
- Pi `>=1.6.0`, Node.js 26.13.x;
- шаблоны ядра в проекте: `npx @dnikulshin/harness init` — они кладут `.pi/harness.version`,
  `.pi/agents/*`, пример конфига.

## Поставить адаптер

```bash
pi install npm:@dnikulshin/pi-harness
```

`-l` (project-local) добавляет пакет в `.pi/settings.json` проекта — так делают, когда версия
адаптера должна быть зафиксирована в репозитории, а не в личных настройках.

Проверить, что видно:

```bash
pi list | grep pi-harness
```

## Проверить совместимость без сессии

```bash
npx pi-harness-check      # 0 — совместимо, 1 — ядро не установлено или версия вне диапазона
```

Те же проверки делает `/cycle` до первого шага. Удобно в CI потребителя: код возврата вместо разбора
текста.

## Первый запуск

```bash
# в сессии Pi, в корне проекта
/cycle
```

Ответ выглядит так:

```
корень: /path/to/project · ядро: 0.2.0 · шаблоны: 0.2.0
Стадия PLAN (running) · шаг plan
Действие: run → PLAN
Причина: plan_missing
Команда: node node_modules/@dnikulshin/harness/scripts/…
```

Дальше — [Команды `/cycle`](Cycle-Commands).
