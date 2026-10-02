# Реакции Луны в модалке дневной цели

Проверено 2026-10-02. Модалка: `showLunaStreakModal()` в `src/main.js`.

| Состояние | Файл | Результат аудита |
|---|---|---|
| 1–2 дня | lil_mascot.png | Уже существовал |
| 3–6 дней | luna_happy.png | Уже существовал |
| 7–13 дней | luna_congrats.png | Уже существовал |
| 14–29 дней и наведение на поздравляющую кнопку до 30 дней | luna_love.png | Перерисован: поднятые руки как у 7–13 дней, без подушки, сердечки в глазах, румянец, два сердечка рядом |
| От 30 дней | luna_absolute.png | Новый аниме-портрет без чиби-пропорций: лицо и плечи, поворот в три четверти, фиолетовые глаза, румянец и небольшая улыбка |
| Прерванная серия | luna_cry.png | Слёзы, грустное выражение, прежнее фиолетовое сердце разбито на две половины |

Новые изображения созданы встроенным `image_gen` с исходными PNG в качестве референсов. У всех итоговых изображений размер 1254×1254, формат PNG RGBA, настоящий прозрачный фон. Сохранены маскот, палитра, костюм и мягкая рисованная стилистика. Финальная реакция для 30+ дней по запросу пользователя отличается композицией и пропорциями: крупный портрет обычной аниме-версии Луны вместо сидящей чиби.

При наведении на кнопку после 30 дней сохраняется `luna_absolute`, чтобы реакция не становилась слабее. Наведение при прерванной серии использует существующую `luna_happy`.

Исходные три изображения не заменялись. Первые, более сдержанные варианты сохранены только для сравнения в игнорируемой папке `release/qa/luna/`.

После замечания о скачках эмоции реакция 14–29 дней продолжает позу с поднятыми руками из 7–13 дней, без возвращения подушки. Для 30+ пользователь выбрал отдельный аниме-портрет с лёгким разворотом и приближением на лице и плечах. В модалке его размер составляет 300×300, с тем же перекрытием карточки на 50px; это сохраняет видимые края на узких экранах. Грустная Луна держит раздельные половины разбитого сердца. Предыдущие варианты сохранены в `release/qa/luna/`.

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
| reaper_photo/luna_absolute.png | 1550792 |
| reaper_photo/luna_cry.png | 948735 |

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

Референсы: `reaper_photo/lil_mascot.png`, `reaper_photo/luna_love.png`.

```text
Use case: stylized-concept / identity-preserve.
Asset: luna_absolute.png, special final 30-day writing goal reward. Reference 1 lil_mascot.png and reference 2 luna_love.png are identity and illustration-style references for the EXACT SAME Luna. Create a genuinely new NON-CHIBI anime portrait of her. The user specifically rejects repeating her seated arms-raised chibi pose.
Composition: close portrait showing her FACE, NECK, SHOULDERS and upper chest. Natural anime head/neck/shoulder proportions, a pretty youthful adult character, NOT a tiny chibi body, NOT a huge baby head, NOT a full-body sprite. Shoulders and torso turned about 25 degrees in three-quarter view, head gently angled back toward the viewer, affectionate eye contact. Hands down and outside the frame, NOT both raised. Warmly adoring joyful expression, softly lifted brows, luminous original violet eyes with bright highlights (normal violet irises, not giant heart-shaped pupils), warm rosy cheek blush, a small graceful happy smile. She should look sweet, lovable and overjoyed to see the viewer; full expressive portrait, not an expression-only edit. No exaggerated open mouth.
Preserve exact recognizable Luna design translated into normal anime proportions: long muted dark-purple hair with original blunt bangs and large soft grouped locks; pale skin; gold crescent moon hair clip and tiny gold star on the viewer-left temple; same purple nightcap with scalloped lavender trim, purple crescent decoration, star at viewer right and purple pompom. Same dark purple outfit, lavender ruffled collar and lavender bow with a pale gold star clasp visible at upper chest. Modest covered shoulders and neckline. Keep her original muted plum/lavender/gold palette.
Style MUST remain the original artist's simple cute soft shaded anime illustration: smooth restrained painted shading, rounded soft dark-purple contour lines, a few broad hair highlights, large simple color shapes, charming minimal facial detail. No ultra-detail, complex hair strand rendering, dramatic realistic lighting, hyperrealism, 3D, gloss or a different manga artist. Do not simply scale up the chibi head. Delicate non-chibi anime face with natural neck and visible shoulders.
Single square 1254x1254 PNG with a truly transparent background, character centered with top of hat around 140–160px and upper chest ending around 1140px, keep all hat and hair inside canvas with safe padding on sides. Portrait occupies most of canvas; face must be visibly larger/more intimate than earlier full-body mascot reactions when displayed at 320px. No scenery, background, frame, text, watermark, pillow, floating heart clutter or raised arms.
```

### luna_cry.png

Редактируемый референс: `reaper_photo/luna_cry.png` до изменения сердца. Его копия сохранена в `release/qa/luna/luna_cry-before-broken-heart.png`.

```text
Use case: precise-object-edit / identity-preserve. Asset luna_cry.png.
Reference 1 luna_cry.png is the EXACT edit target. Make a surgical change to the PURPLE HEART CUSHION ONLY: the heart must be visibly BROKEN into TWO SEPARATE HALVES with a clear jagged lightning-shaped split running from the heart's top center notch all the way down to its bottom point. Separate the halves slightly (a clearly visible gap about 35–50px at 1254px canvas), with complementary zigzag broken edges. Luna holds the left half in her left mitten hand and right half in her right mitten hand, keeping both original hands in approximately their existing positions. The original dark crescent-and-feather emblem is split across the two halves. In the gap show her existing dark-purple outfit behind, not a glued-together unbroken heart. The two halves must together remain unmistakably the original purple heart, now symbolically broken. No tiny decorative crack: a real easily readable broken-heart silhouette, visible at small modal size.
Preserve EVERYTHING ELSE as closely as possible: exact crying face with original purple watery eyes and tears, sad tiny mouth, pose, chibi proportions, original long muted dark-purple hair silhouette and bangs, gold crescent/star clips, same nightcap, lavender trim, purple crescent/star/pompom, original outfit and sleeve stars, shoes, hands, original scale and positioning. Same purple heart material, colors, smooth restrained shading, soft dark linework, hand-drawn cute anime chibi style. No extra damage, fragments, stuffing, gore, new objects, new expression, text, background, scenery or redesign.
Single square 1254x1254 PNG, genuine transparent background, preserve original transparent padding and exact character placement.
```
