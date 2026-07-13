# 🌌 Nocturne Writer

<p align="center">
  <img src="./reaper_photo/lil_mascot.png" width="160" alt="Luna Mascot" />
</p>

<p align="center">
  <b>Локальное, приватное и вдохновляющее приложение для писателей.</b><br>
  <i>Local-first, E2E encrypted manuscript editor & world-building database.</i>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Version-1.1.2-purple?style=for-the-badge" alt="Version 1.1.2" />
  <img src="https://img.shields.io/badge/Platform-Web%20%7C%20Electron%20%7C%20Android-blue?style=for-the-badge" alt="Platforms" />
  <img src="https://img.shields.io/badge/Security-AES--GCM-success?style=for-the-badge" alt="Security" />
  <img src="https://img.shields.io/badge/Local--First-Offline%20Ready-orange?style=for-the-badge" alt="Local First" />
</p>

---

## 🌟 Основные особенности / Key Features

### ✍️ Умный текстовый редактор / Smart Manuscript Editor
- **Визуальное разделение на страницы (Visual Pagination)**: Пишите как в настоящей книге с постраничным разбиением на лету.
- **Эффекты письма (Writing Effects)**: Визуальный отклик при наборе (эффекты «Туман» / Mist, «Волна» / Ripple, «Искры» / Sparkles).
- **Автоформатирование**: Автоматическое преобразование дефисов во фреймворке (двойной дефис `--` в длинное тире `—`, одиночный между словами в среднее тире `–`) с возможностью быстрого отката кнопкой Backspace.
- **Отключение автосписков**: Полная свобода творчества без раздражающих автоматических списков Tiptap.

### 📚 База знаний и Мироустройство / Knowledge Base & Lore
- **Досье сущностей**: Интерактивные карточки персонажей, локаций, событий и заметок.
- **Таймлайны и связи**: Визуализация сквозных ассоциаций между персонажами, местами и главами рукописи.
- **Статус выполнения**: Отметка «Исполнено» для карточек заметок с изящным адаптивным дизайном.

### 🌙 Маскот Луна и Цели дня / Daily Goal & Luna Mascot
- **Цепочка дней (Daily Streak)**: Мотивационная система с маскотом Луной. Задавайте ежедневную цель по объему слов, держите стрик и получайте поздравления!
- **Эмоциональные состояния Луны**: Луна меняет облик в зависимости от вашего прогресса: от милого талисмана до праздничной или грустной формы (если цепочка была прервана).
- **Защита от накрутки**: Умный вотермарк документов (`highWatermark`), блокирующий начисление фальшивых слов при Undo/Redo и копипасте, при этом учитывающий полное переписывание крупных абзацев (от 15 слов).

### 🔒 Безопасность и Приватность / Security & Privacy
- **Сквозное шифрование (E2E Encryption)**: Защита проектов с помощью алгоритма AES-GCM (через стандартный WebCrypto API). Ваши тексты расшифровываются исключительно в памяти вашего браузера.
- **Никаких облаков**: Полностью оффлайн-приложение. persistent-хранилище в локальной БД IndexedDB.

---

## 🎨 Визуальные темы / Visual Themes

Nocturne Writer спроектирован с упором на эстетику, которая помогает погрузиться в атмосферу творчества:
- **Nocturne Adaptive**: Интеллектуальная темная тема, автоматически подстраивающая цвета и тени под выбранный вами акцентный цвет.
- **Blazing Black**: Абсолютно чёрная тема для OLED-дисплеев с огненными алыми акцентами для ночной работы.
- **Paper Light**: Спокойная и контрастная светлая тема, имитирующая качественную книжную бумагу.
- **Cyberpunk Matrix & Lavender Bloom**: Стилизованные темы с ретро-футуристичной атмосферой.

---

## 🛠️ Запуск проекта / Getting Started

### 🌐 Веб-версия (Dev Server)
Для запуска локальной веб-версии не требуется сборщик (No Vite/Webpack in dev mode). Приложение запускается напрямую:
```bash
npm install
npm run dev
```
Откройте в браузере: `http://localhost:5173`.

### 💻 Десктопная версия (Electron)
Запуск в режиме разработчика Electron:
```bash
# В одном терминале:
npm run dev

# Во втором терминале:
npm run electron:dev
```
Сборка локального дистрибутива:
```bash
python web2exe_fixed.py
```
Собранный установщик появится в папке `dist/Nocturne Writer Setup 1.1.2.exe`.

### 📱 Мобильная версия (Android APK)
Сборка отладочного APK с использованием Capacitor:
```bash
npm run build
npx cap add android
npm run android:sync
npm run android:build:debug
```
Путь к сгенерированному файлу: `android/app/build/outputs/apk/debug/app-debug.apk`.

---

## 📂 Структура проекта / Architecture

```text
index.html          ← Точка входа (загружает CSS и src/main.js)
src/
  main.js           ← Монолит логики интерфейса и поведения (~750 KB)
  core/
    db.js           ← Обёртка для работы с базой IndexedDB
    crypto.js       ← Сквозное шифрование проектов (AES-GCM)
    utils.js        ← Утилиты подсчета слов и работы с текстом
  editor/
    nocturne-editor.js ← Конфигурация ProseMirror (Tiptap) и плагины
  css/                ← Стили оформления и темы
electron/
  main.cjs          ← Главный процесс Electron
  preload.cjs       ← ContextBridge и безопасное IPC-взаимодействие
```

---

## 📜 Лицензия / License

Разработано командой **BebraNova**. Все права защищены.  
*Developed with ❤️ by BebraNova.*
