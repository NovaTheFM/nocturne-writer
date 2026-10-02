# Реакции Луны в модалке дневной цели

Проверено 2026-10-02. Модалка: `showLunaStreakModal()` в `src/main.js`.

| Состояние | Файл | Результат аудита |
|---|---|---|
| 1–2 дня | lil_mascot.png | Уже существовал |
| 3–6 дней | luna_happy.png | Уже существовал |
| 7–13 дней | luna_congrats.png | Уже существовал |
| 14–29 дней и наведение на поздравляющую кнопку до 30 дней | luna_love.png | Перерисован: поднятые руки как у 7–13 дней, без подушки, сердечки в глазах, румянец, два сердечка рядом |
| От 30 дней | luna_absolute.png | Перерисован: та же поза с поднятыми руками, компактная улыбка, сердечки в глазах, слёзы радости, четыре сердечка рядом |
| Прерванная серия | luna_cry.png | Создан: слёзы, грустное выражение, объятия с прежней подушкой |

Новые изображения созданы встроенным `image_gen` с исходными PNG в качестве референсов. У всех итоговых изображений размер 1254×1254, формат PNG RGBA, настоящий прозрачный фон. Сохранены маскот, палитра, костюм, мягкая рисованная стилистика и масштаб. Более сильные поздравления сопровождаются более выраженными восторгом и любовью.

При наведении на кнопку после 30 дней сохраняется `luna_absolute`, чтобы реакция не становилась слабее. Наведение при прерванной серии использует существующую `luna_happy`.

Исходные три изображения не заменялись. Первые, более сдержанные варианты сохранены только для сравнения в игнорируемой папке `release/qa/luna/`.

После замечания о скачках эмоции исправлена последовательность: подушка остаётся в ранних реакциях, а начиная с 7 дней Луна постоянно держит руки поднятыми. Изображения 14–29 и 30+ созданы на основе `luna_congrats.png` и исправленной `luna_love.png`. У высшей реакции уменьшена высота рта; усиление любви передают глаза, румянец, слёзы радости и сердечки. Отклонённые варианты сохранены в `release/qa/luna/`.

## Проверка

- `npm.cmd run check`: проверен синтаксис 66 файлов, тесты адаптера редактора прошли.
- `npm.cmd run build`: веб-сборка создана в `dist/`; SHA-256 каждого нового изображения совпадает с копией в `dist/reaper_photo/`.
- `npm.cmd run smoke:desktop`: существующая проверка приложения прошла.
- `node release/qa/luna/smoke.mjs`: 33 сценария на экранах 1440×920, 390×844 и 360×640. Проверены границы диапазонов дней, декодирование PNG, видимые границы маскота и кнопки, наведение и возврат реакции, закрытие клавиатурой и касанием; ошибок загрузки изображений и JavaScript нет.
- Скриншоты, скрипт проверки и `results.json` находятся в игнорируемой папке `release/qa/luna/`. Нативные Electron/Android-сборки не запускались.
- `luna-reactions-preview.html`: отдельный просмотр шести снимков настоящих модалок с исходными стилями приложения, расположенных от прерванной серии до 30 дней. Открывается через локальный сервер; снимки не выполняют действия с данными приложения.

| Новый файл | Размер в байтах |
|---|---:|
| reaper_photo/luna_love.png | 959711 |
| reaper_photo/luna_absolute.png | 1009061 |
| reaper_photo/luna_cry.png | 915571 |

## Итоговые промпты

Референсы указаны в том порядке, в котором передавались встроенному инструменту.

### luna_love.png

Референс: `reaper_photo/luna_congrats.png`.

```text
Use case: identity-preserve. Correct luna_love.png, the 14–29-day reaction in a strictly escalating sprite sequence. This is an extremely faithful edit of reference 1, the EXISTING luna_congrats.png (7–13 days). Preserve its exact full-body seated pose WITH BOTH HANDS RAISED in celebration, entire outfit and original framing. DO NOT include any cushion or held heart. Never revert to the earlier hugging-cushion pose.
Change the face to noticeably MORE happy, excited and lovingly overwhelmed than the reference 7-day image. Her original large purple eyes now have vivid shining pink-lavender HEART-SHAPED pupils, retain original thick lashes and large white highlights. Lift brows slightly with excitement and intensify soft rosy blush on both cheeks. Her mouth is a joyful open smile with a gently upturned top edge and pink tongue in the same rendering as the original, approximately the SAME SIZE as the original mouth, NEVER bigger or elongated; keep it compact and cute. Add two small lavender-pink floating hearts near the sides of her raised hands, with the original dark outline and soft shading.
Critical invariants: EXACT same Luna character, face shape, scale, bangs and long dark muted-purple hair silhouette, gold crescent and star clips at viewer left, dark purple nightcap with scalloped lavender trim, purple crescent and star, pompom, lavender collar and bow with gold star clasp, original dark dress, sleeves, ruffled hem and shoes. Keep original gold stars on sleeves and round mitten hands. Preserve original restrained painted shading, soft dark linework, palette and hand-drawn anime chibi sticker style. Change only expression and add floating hearts; keep original raised-arm posture and prop continuity with 7–13 and 30+.
Single square PNG with genuinely transparent background, 1254x1254 matching reference, original character position and padding, no floor, text, watermark, extra objects or restyling. It must read as a happier loving upgrade of the SAME 7-day pose, even at small modal size.
```

### luna_absolute.png

Референсы: `reaper_photo/luna_love.png`, `reaper_photo/luna_congrats.png`.

```text
Use case: identity-preserve. Correct luna_absolute.png, the final 30+ day reaction, using the newly corrected 14-day luna_love.png as the EXACT edit target. Reference 2 luna_congrats.png locks original mascot style and anatomy. Continue the same visual sequence: EXACT same seated full-body pose with both hands raised, NO cushion or held prop.
MOST CRITICAL CORRECTION: make the mouth a NATURAL COMPACT delighted smile, a small upward-curved open crescent with pink tongue, approximately 65 pixels wide by 35 pixels tall on a 1254px square. This is less than half the vertical height of the target reference's mouth. Keep surrounding cheek and chin proportions unchanged. Do NOT create a huge vertical oval, a tall open mouth, a large shouting mouth, an exaggerated gape, jaw distortion, broad white teeth or bulging lips. The joy comes from eyes and blush, NEVER from enlarging the mouth.
Emotion must be MORE overjoyed and lovingly overwhelmed than the 14-day reference: the same huge brilliant purple eyes with heart-shaped pink-lavender pupils, make those heart pupils slightly larger and more luminous within the unchanged original iris size; retain original dark lashes and white highlights. Add a tiny glossy pale-lavender tear of JOY at the outside lower corner of each eye, rosy blush, and FIVE small lavender-pink floating hearts around head and raised hands instead of the original two. Keep hearts moderate, not enormous, avoid covering hat or cropping. Face should radiate grateful bliss and love, compact cute happy mouth consistent with the original artist's style.
Do an extremely faithful minimal edit. Preserve EXACT target character position, 1254x1254 canvas, original head/body scale, raised-arm pose, round mitten hands, original face outline and bangs, long dark purple hair silhouette, gold crescent and star hair clips at viewer left, original dark purple nightcap with scalloped lavender trim, purple crescent, purple star and pompom, lavender collar and bow with pale gold star clasp, outfit ruffles, original boots and sleeve stars. Preserve reference dark soft outlines, restrained smooth painted shading and original muted purple/lavender/gold palette. No restyling, no extra costume or accessories. Single square full-body PNG with genuinely transparent background, no floor, text, border, watermark, new props or scene.
```

### luna_cry.png

Референсы: `reaper_photo/lil_mascot.png`, `reaper_photo/luna_happy.png`.

```text
Use case: identity-preserve. Asset luna_cry.png, missing sad/crying reaction when the daily writing streak is broken.
Reference 1 lil_mascot.png is the EXACT edit target. Reference 2 luna_happy.png is a supporting reference of the same face rendering and character identity.
Edit ONLY facial expression on reference 1 to gently and clearly crying: original huge purple eyes watery with glossy pale lavender tears pooling at lower lids, one short tear down each cheek, eyebrows tilted upward at their inner ends, small trembling sad downturned mouth. Original blush should be softer. Keep her hugging the SAME purple heart pillow with exact original dark crescent-and-feather emblem as a comfort object. She should be recognizably affectionate and softly disappointed, not angry, scary, dramatic despair or injured.
Preserve EXACT reference full-body seated pose, original same hands, original head size and face outline, dark muted purple hair silhouette and bangs, same hair highlights, pale gold crescent and star clips at viewer left, dark purple nightcap with lavender scalloped trim, purple crescent on hat, star at viewer right and pompom, original outfit lavender collar, gold sleeve stars, skirt ruffles and shoes. Keep the original dark outlines, soft restrained smoothly painted shading, muted purple/lavender/gold palette and cute hand-drawn chibi anime sticker style. No reinterpretation or redesign. Same square canvas framing, centered character at original scale and padding so it crossfades neatly with happy reference. Single square PNG with genuinely transparent background, no scene, floating hearts, extra props, shadows, text, border or watermark.
```
