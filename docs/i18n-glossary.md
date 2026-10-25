# Localization glossary

Terms the game uses everywhere: translate them the same way in every string. English is the source of truth
(`src/i18n/locales/en.ts`); Ukrainian (`uk.ts`), German (`de.ts`) and Polish (`pl.ts`) are complete; a key missing in a
locale falls back to English.

## How the locale files work

- Flat keys, `{param}` placeholders. Keep every placeholder of the English text; the coverage test
  (`src/i18n/coverage.test.ts`) fails on an unknown key or an invented placeholder.
- Plurals are objects selected by `{count}`: English / German `one`, `other`; Ukrainian / Polish `one`, `few`, `many`,
  `other` (`other` = fractions, e.g. "1,5"). Write all the forms your language has.
- Some params exist only for inflecting languages: `resGen` / `resAcc` (resource name after a number / as an object),
  `statusAcc` / `statusTarget`, `sign` (`+` or `−` before a number). Use the form your grammar needs.
- Stat names (`stat.*`) are shown inside modifier lines (`mod.*`): pick the grammatical form your `mod.*` templates
  need (Ukrainian uses the genitive: "+4% життя").
- Content names are keyed by content id: `class.<id>.name`, `skill.<id>.name`, `support.<id>.name` / `.description`,
  `passive.<id>.name`, `spec.<id>.name`, `base.<id>.name`, `mob.<id>.name`, `item.rare.first|second.<Word>`,
  `unique.<id>.name` / `unique.<id>.effect` (uniques and legendaries; the effect's numbers are placeholders filled from
  data: `{pct}` is a formatted percentage, `{count}` selects the plural, `{seconds}` / `{amount}` are numbers, `{resGen}`
  is the class resource after a number).
- Numbers get the locale decimal separator automatically ("0.5" / "0,5").
- German and Polish run ~30% longer than Ukrainian: buttons shrink their caption to fit, but prefer the shorter of
  two equally good wordings for buttons, tabs and HUD captions.
- Rare item names (`item.rare.*`) are translated in every language (designer decision 2026-10-23), built so no gender
  agreement is needed. German avoids agreement with one compound noun (`{first}{second}`,
  second words lower-case: "Blut" + "krone" = "Blutkrone"); Polish and Ukrainian with head noun + genitive noun
  (`{second} {first}`: "Korona Krwi", "Корона Крові").
- German grammar: stat names are nominative noun phrases ("max. Leben"), increased / reduced are "+N% / −N% <stat>"
  (no "erhöhte / erhöhter / erhöhtes" agreement), tags go in parentheses ("(Zauber)"). The player is "du".
- Polish grammar: stat names in the genitive ("+4% maks. życia", "20% więcej obrażeń"), tags in parentheses in the
  nominative ("(zaklęcia)"); avoid gendered past forms addressing the player ("Nie żyjesz", not "Zginąłeś").

## Terms

| Term (id / context) | English | Українська | Deutsch | Polski |
|---|---|---|---|---|
| Life | Life | Життя | Leben | Życie |
| Mana (mage resource) | Mana | Мана | Mana | Mana |
| Rage (warrior resource) | Rage | Лють | Wut | Furia |
| Energy (ranger resource) | Energy | Енергія | Energie | Energia |
| Resource (any class resource) | Resource | Ресурс | Ressource | Zasób |
| Energy Shield | Energy Shield | Енергетичний щит (ЕЩ) | Energieschild | Tarcza energetyczna (TE) |
| Armour | Armour | Броня | Rüstung | Pancerz |
| Resistance (fire / cold / lightning) | Fire / Cold / Lightning Resistance | Опір вогню / холоду / блискавці | Feuer- / Kälte- / Blitzwiderstand | Odporność na ogień / zimno / błyskawice |
| Damage | Damage | Урон | Schaden | Obrażenia |
| Physical / Fire / Cold / Lightning | Physical / Fire / Cold / Lightning | Фізичний / вогняний / холодний / блискавичний | Physisch / Feuer / Kälte / Blitz (physischer Schaden, Feuerschaden …) | Fizyczne / od ognia / od zimna / od błyskawic |
| Melee / Projectile / Spell / Area / Attack | Melee / Projectile / Spell / Area / Attack | Ближній бій / снаряди / заклинання / область / атака | Nahkampf / Projektil / Zauber / Fläche / Angriff | Walka wręcz / pocisk / zaklęcie / obszar / atak |
| Critical Strike | Critical Strike (crit) | Критичний удар (крит) | Kritischer Treffer (Krit) | Trafienie krytyczne (kryt) |
| Critical Strike Multiplier | Critical Strike Multiplier | Множник криту | Kritischer Treffermultiplikator | Mnożnik trafienia krytycznego |
| Attack Speed / Cast Speed | Attack Speed / Cast Speed | Швидкість атаки / касту | Angriffs- / Zaubergeschwindigkeit | Szybkość ataku / rzucania |
| Movement Speed | Movement Speed | Швидкість руху | Bewegungsgeschwindigkeit (kurz: Lauftempo) | Szybkość ruchu |
| Cooldown | Cooldown | Кулдаун | Abklingzeit | Odnowienie (czas odnowienia) |
| increased / reduced (additive %) | increased / reduced | +N% / −N% | +N% / −N% | +N% / −N% |
| more / less (multiplicative %) | more / less | більше / менше (more) | mehr / weniger | więcej / mniej |
| Ignite | Ignite | Підпал | Entzündung (entzünden, entzündet) | Podpalenie (podpalić) |
| Bleed | Bleed | Кровотеча | Blutung | Krwawienie |
| Freeze | Freeze | Заморозка | Einfrieren (eingefroren) | Zamrożenie (zamrozić) |
| Stun / Stun bar | Stun / Stun bar | Оглушення / шкала оглушення | Betäubung / Betäubungsleiste | Ogłuszenie / pasek ogłuszenia |
| Slow | Slow | Сповільнення | Verlangsamung | Spowolnienie |
| Leech (life from damage) | Leech / Vampirism | Вампіризм | Lebensraub (Support: Vampirismus) | Wampiryzm |
| Knock Back | Knock Back | Відкидання | Rückstoß | Odrzut |
| Pierce | Pierce | Пробиття | Durchbohren | Przebicie |
| Skill | Skill | Скіл | Fertigkeit | Umiejętność |
| Basic attack | Basic attack | Базова атака | Grundangriff | Atak podstawowy |
| Support (skill modifier gem) | Support | Модифікатор | Modifikator | Modyfikator |
| Supports collection (tab) | Collection | Вкладка | Sammlung | Kolekcja |
| Tier (support / affix) | Tier (I, II, III) | Тир | Rang (kurz: T) | Ranga (skrót: T) |
| Socket / slot | Socket / slot | Вставити / слот | Einsetzen / Slot | Osadź / gniazdo |
| Salvage | Salvage | Розібрати | Zerlegen | Rozbierz |
| Shards (salvage currency) | Shards | Осколки | Splitter | Odłamki |
| Essence (rare crafting currency, 0.3) | Essence | Есенція | Essenz | Esencja |
| Craft (inventory tab / to craft) | Craft | Крафт / крафтити | Handwerk / bearbeiten | Rzemiosło / przerabiać |
| Affix (item modifier line) | Affix | Афікс | Affix (pl. Affixe) | Afiks |
| Upgrade (rarity, craft operation) | Upgrade | Покращити | Aufwerten | Ulepsz |
| Reroll (craft operation) | Reroll | Перекинути (перекат) | Neu würfeln | Przelosuj |
| Remove (affix, craft operation) | Remove | Видалити | Entfernen | Usuń |
| Affix slot (free prefix / suffix place) | Affix slot | Слот афікса | Affix-Slot | Gniazdo afiksu |
| Talents (passive tree screen) | Talents | Таланти | Talente | Talenty |
| Passive point / talent point | Talent point | Очко талантів | Talentpunkt | Punkt talentów |
| Small node / Notable / Keystone | Small node / Notable / Keystone | Малий / значний / ключовий вузол | Kleiner / Bedeutender Knoten / Schlüsselknoten | Mały / znaczący węzeł / węzeł kluczowy |
| Specialization (branch) | Specialization | Спеціалізація | Spezialisierung | Specjalizacja |
| Wheel (main passive tree) | Wheel | Колесо | Rad | Koło |
| Respec / refund | Reset / Refund | Скинути / зняти | Zurücksetzen / Entfernen | Resetuj / cofnij |
| Item level | Item level | Рівень предмета | Gegenstandsstufe | Poziom przedmiotu |
| Normal / Magic / Rare / Unique / Legendary | Normal / Magic / Rare / Unique / Legendary | Звичайний / магічний / рідкісний / унікальний / легендарний | Normal / Magisch / Selten / Einzigartig / Legendär | Zwykły / magiczny / rzadki / unikatowy / legendarny |
| Prefix / Suffix (short) | P / S | П / С | P / S | P / S |
| Stash | Stash | Сховище | Truhe | Skrytka |
| Inventory | Inventory | Інвентар | Inventar | Ekwipunek |
| Equip / Unequip | Equip / Unequip | Вдягнути / зняти | Anlegen / Ablegen | Załóż / zdejmij |
| Run (one map / arena session) | Run | Забіг | Lauf | Wyprawa |
| Wave | Wave | Хвиля | Welle | Fala |
| Map (one level of the map ladder, 0.4) | Map | Карта | Karte | Mapa |
| Dungeon ("Enter the dungeon") | Dungeon | Підземелля | Kerker | Loch |
| Room / Boss room | Room / Boss room | Кімната / кімната боса | Raum / Bossraum | Komnata / komnata bossa |
| Altar (summons the boss) / awaken | Altar / awaken | Алтар / пробудити | Altar / erwecken | Ołtarz / przebudzić |
| Chest (won run reward) | Chest | Скриня | Schatzkiste | Skrzynia |
| Consolation (failed run reward) | Consolation | Втішна нагорода | Trostpreis | Nagroda pocieszenia |
| Unlock (a map) | Unlock | Відкрити | Freischalten | Odblokować |
| End run (abandon from pause) | End run | Завершити забіг | Lauf beenden | Zakończ wyprawę |
| Hub | Hub | Хаб | Lager | Obóz |
| Loot | Loot | Здобич | Beute | Łupy |
| Elite / Boss | Elite / Boss | Еліта / бос | Elite / Boss | Elita / boss |
| Elite modifiers (fast / fat / fiery / explosive) | Fast / Fat / Fiery / Explosive | Швидкий / Товстий / Вогняний / Вибуховий | Schnell / Massig / Feurig / Explosiv | Szybki / Gruby / Ognisty / Wybuchowy |
| XP | XP | Досвід | EP | PD |
| Level Up | Level Up | Новий рівень | Stufenaufstieg (Level = Stufe) | Nowy poziom |
| Hero / Character | Hero | Герой | Held | Bohater |
| LMB / RMB (mouse buttons) | LMB / RMB | ЛКМ / ПКМ | LMT / RMT | LPM / PPM |

## Classes, specializations, keystones

| Id | English | Українська | Deutsch | Polski |
|---|---|---|---|---|
| warrior | Warrior | Воїн | Krieger | Wojownik |
| ranger | Ranger | Рейнджер | Waldläufer | Łowca |
| mage | Mage | Маг | Magier | Mag |
| berserker | Berserker | Берсерк | Berserker | Berserker |
| guardian | Guardian | Страж | Wächter | Strażnik |
| sniper | Sniper | Снайпер | Scharfschütze | Snajper |
| trapper | Trapper | Трапер | Fallensteller | Traper |
| pyromancer | Pyromancer | Піромант | Pyromant | Piromanta |
| cryomancer | Cryomancer | Кріомант | Kryomant | Kriomanta |
| k_blood | Blood Magic | Кровова жертва | Blutmagie | Magia krwi |
| k_precise | Precise Hand | Точна рука | Präzise Hand | Precyzyjna dłoń |
| k_crystal | Crystal Shell | Кришталевий панцир | Kristallpanzer | Kryształowa powłoka |
| k_swift | Swift Feet | Швидкі ноги | Flinke Füße | Chyże stopy |
| k_leech | Bloodsucker | Кровопивець | Blutsauger | Krwiopijca |
| k_glass | Glass Cannon | Скляна гармата | Glaskanone | Szklane działo |

## Uniques and legendaries

Names are proper names: translate the meaning, keep them short; Ukrainian names come from the designer (`docs/design/items.md`).
A unique's drawback lines read `item.cost` ("Cost: …" / "Ціна: …"); the chest banner for a legendary drop is `run.legendary`.

| id | English | Українська | Deutsch | Polski |
|---|---|---|---|---|
| glass_cannon_crown | Glass Cannon Crown | Вінець Скляної Гармати | Krone der Glaskanone | Korona Szklanego Działa |
| splitter | Splitter | Розщеплювач | Spalter | Rozszczepiacz |
| heart_of_winter | Heart of Winter | Серце Зими | Herz des Winters | Serce Zimy |
| barrow_reaper | Barrow Reaper | Жнець Курганів | Hügelgrabschnitter | Żniwiarz Kurhanów |
| iron_heart_oath | Iron Heart Oath | Клятва Залізного Серця | Schwur des Eisenherzens | Przysięga Żelaznego Serca |
| bloody_pupil | Bloody Pupil | Кривава Зіниця | Blutige Pupille | Krwawa Źrenica |
| ancestral_horn | Ancestral Horn | Ріг Предків | Horn der Ahnen | Róg Przodków |
| madman_gloves | Madman's Gloves | Рукавиці Безумця | Handschuhe des Wahnsinnigen | Rękawice Szaleńca |
| shadow_boots | Shadow Boots | Чоботи Тіні | Schattenstiefel | Buty Cienia |
| rift_ring | Rift Ring | Перстень Розлому | Ring des Risses | Pierścień Szczeliny |
| devourer_crown (legendary) | Devourer's Crown | Корона Пожирача | Krone des Verschlingers | Korona Pożeracza |
| Soul (crown resource) | Soul | Душа | Seele | Dusza |
| clock_last_moment (legendary) | Clock of the Last Moment | Годинник Останньої Миті | Uhr des Letzten Augenblicks | Zegar Ostatniej Chwili |
| Last Moment (clock name part) | Last Moment | Остання мить | Letzter Augenblick | Ostatnia chwila |
| Time stop (clock effect) | Time stops | Час зупиняється | Die Zeit bleibt stehen | Czas się zatrzymuje |
| "rewinding" (clock recharge) | rewinding | «заводиться» | sich aufziehen | nakręcać się |
