# Реакции Луны в модалке дневной цели

Проверено 2026-10-02. Модалка: `showLunaStreakModal()` в `src/main.js`.

| Состояние | Файл | Результат аудита |
|---|---|---|
| 1–2 дня | lil_mascot.png | Уже существовал |
| 3–6 дней | luna_happy.png | Уже существовал |
| 7–13 дней | luna_congrats.png | Уже существовал |
| 14–29 дней и наведение на поздравляющую кнопку до 30 дней | luna_love.png | Создан: сердечки в глазах, широкая улыбка, два сердечка рядом |
| От 30 дней | luna_absolute.png | Создан: крупные сердечки в глазах, слёзы радости, раскрытые объятия, пять сердечек рядом |
| Прерванная серия | luna_cry.png | Создан: слёзы, грустное выражение, объятия с прежней подушкой |

Новые изображения созданы встроенным `image_gen` с исходными PNG в качестве референсов. У всех итоговых изображений размер 1254×1254, формат PNG RGBA, настоящий прозрачный фон. Сохранены маскот, палитра, костюм, мягкая рисованная стилистика и масштаб. Более сильные поздравления сопровождаются более выраженными восторгом и любовью.

При наведении на кнопку после 30 дней сохраняется `luna_absolute`, чтобы реакция не становилась слабее. Наведение при прерванной серии использует существующую `luna_happy`.

Исходные три изображения не заменялись. Первые, более сдержанные варианты сохранены только для сравнения в игнорируемой папке `release/qa/luna/`.

## Проверка

- `npm.cmd run check`: проверен синтаксис 66 файлов, тесты адаптера редактора прошли.
- `npm.cmd run build`: веб-сборка создана в `dist/`; SHA-256 каждого нового изображения совпадает с копией в `dist/reaper_photo/`.
- `npm.cmd run smoke:desktop`: существующая проверка приложения прошла.
- `node release/qa/luna/smoke.mjs`: 33 сценария на экранах 1440×920, 390×844 и 360×640. Проверены границы диапазонов дней, декодирование PNG, видимые границы маскота и кнопки, наведение и возврат реакции, закрытие клавиатурой и касанием; ошибок загрузки изображений и JavaScript нет.
- Скриншоты, скрипт проверки и `results.json` находятся в игнорируемой папке `release/qa/luna/`. Нативные Electron/Android-сборки не запускались.
- `luna-reactions-preview.html`: отдельный просмотр шести снимков настоящих модалок с исходными стилями приложения, расположенных от прерванной серии до 30 дней. Открывается через локальный сервер; снимки не выполняют действия с данными приложения.

| Новый файл | Размер в байтах |
|---|---:|
| reaper_photo/luna_love.png | 944078 |
| reaper_photo/luna_absolute.png | 1045468 |
| reaper_photo/luna_cry.png | 915571 |

## Итоговые промпты

Референсы указаны в том порядке, в котором передавались встроенному инструменту.

### luna_love.png

Референсы: `reaper_photo/lil_mascot.png`, `reaper_photo/luna_congrats.png`.

```text
Use case: identity-preserve. Asset luna_love.png, the FOURTH reaction (14-day streak), stronger and more lovingly exaggerated than the THIRD open-eyed arms-raised congratulation.
Reference 1 lil_mascot.png: exact edit target for character identity, outfit, pose, layout and style. Reference 2 luna_congrats.png: emotional baseline which this new sprite must clearly exceed.
Keep the EXACT same seated chibi Luna with the exact same purple nightcap, hair shape, crescent/star hair clips, outfit, shoes, gold sleeve stars and same purple heart pillow bearing a dark crescent/feather emblem. Make her lovingly delighted to an exaggerated level: huge shining open purple eyes with prominent lavender heart-shaped pupils, bright rosy blush, a wider open ecstatic pink smile than the congrats reference. Hug her original heart cushion very tightly in her original seated pose. Add TWO small floating lavender hearts, one on each side of her head, in the SAME soft outlined shaded illustration style, kept within original transparent padding.
All non-expression features must faithfully match the reference character. Exact dark-purple hair, skin tone, lavender hat ruffles, purple crescent/star and pompom, pale gold hair crescent/star, full body proportions, original hand-drawn chibi anime linework, restrained soft shaded painting and color palette. Keep the original sprite scale and layout for modal crossfades. Do not switch to new art style, glossy 3D or add fine details. Genuine transparent background, single square full-body PNG, no scene, floor, text, watermark or border. Love and excitement must read clearly even as a small app mascot.
```

### luna_absolute.png

Референсы: `reaper_photo/luna_congrats.png`, `reaper_photo/luna_love.png`.

```text
Use case: identity-preserve. Asset luna_absolute.png: FINAL FIFTH reaction, 30-day writing streak, an exaggerated explosion of loving gratitude and joy. It MUST look visibly MORE ecstatic and MORE loving than reference 2's heart eyes and two floating hearts.
Reference 1 luna_congrats.png is the exact character, outfit, raised-arms seated pose and style edit target. Reference 2 luna_love.png is the fourth reaction: emotional minimum to EXCEED.
Keep exact reference Luna identity and art style. Seated full-body Luna throws BOTH same round mitten hands upward and outward as if asking for a giant hug. Face is overwhelmed by love: her very large original purple irises contain HUGE glowing lavender-pink heart-shaped pupils taking most of each iris, retain the same lash shapes. Two small transparent pale lavender tears of JOY glisten at the outer bottom eye corners; bright rosy cheeks, the widest delighted open pink smile in the set. Add a cluster of FIVE buoyant lavender-pink hearts around her head and raised hands, slightly varied sizes, same dark outlined softly painted style. Keep full character, hearts and original hat inside canvas without cropping, with original central sprite position and head/body scale.
Precisely preserve long dark muted purple hair silhouette and fringe, purple nightcap silhouette, scalloped lavender hat trim, crescent symbol, star on viewer right and pompom, pale gold crescent and star hair clips at viewer left, original lavender collar and bow with pale gold star clasp, dark purple outfit with lavender ruffles, gold sleeve stars, original shoes and seated body proportions. Same soft dark outlines and smooth restrained shading. This is the same existing hand-drawn anime chibi sticker, not a redesign. Do not add new costume pieces, cushion, accessories or text. No scene, floor shadow, glow halo, background, lettering, watermark, border. Single square PNG with genuinely transparent background. The highest affection reaction should be instantly distinct even displayed at small modal size.
```

### luna_cry.png

Референсы: `reaper_photo/lil_mascot.png`, `reaper_photo/luna_happy.png`.

```text
Use case: identity-preserve. Asset luna_cry.png, missing sad/crying reaction when the daily writing streak is broken.
Reference 1 lil_mascot.png is the EXACT edit target. Reference 2 luna_happy.png is a supporting reference of the same face rendering and character identity.
Edit ONLY facial expression on reference 1 to gently and clearly crying: original huge purple eyes watery with glossy pale lavender tears pooling at lower lids, one short tear down each cheek, eyebrows tilted upward at their inner ends, small trembling sad downturned mouth. Original blush should be softer. Keep her hugging the SAME purple heart pillow with exact original dark crescent-and-feather emblem as a comfort object. She should be recognizably affectionate and softly disappointed, not angry, scary, dramatic despair or injured.
Preserve EXACT reference full-body seated pose, original same hands, original head size and face outline, dark muted purple hair silhouette and bangs, same hair highlights, pale gold crescent and star clips at viewer left, dark purple nightcap with lavender scalloped trim, purple crescent on hat, star at viewer right and pompom, original outfit lavender collar, gold sleeve stars, skirt ruffles and shoes. Keep the original dark outlines, soft restrained smoothly painted shading, muted purple/lavender/gold palette and cute hand-drawn chibi anime sticker style. No reinterpretation or redesign. Same square canvas framing, centered character at original scale and padding so it crossfades neatly with happy reference. Single square PNG with genuinely transparent background, no scene, floating hearts, extra props, shadows, text, border or watermark.
```
